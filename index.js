const EventEmitter = require('events')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')
const msgpack = require("msgpack-lite");

module.exports = class Bridge extends EventEmitter {
	constructor({WAMP: {endpoint: wampEndpoint}, ZRE: {reflectionGroups = ['WAMP-Bridge reflections']}}) {
		super();
		this.wampEndpoint = wampEndpoint // format {url: String, realm: String}
		this.zreReflectionGroups = reflectionGroups

		this.zreObserverNode = Zyre.new({name: 'WAMP Bridge', headers: {[Bridge.getVersionHeaderKey()]: Bridge.getVersion()}})
		this.wampObserverNode = new Autobahn.Connection(this.wampEndpoint)

		/**
		 * A dictionary that maps a ZRE-node's ID to its coresponding Autobahn connection.
		 */
		this.wampReflectionsOfZreNodes = new Map()
		/**
		 * A dictionary that maps a WAMP-node's current session ID to its corresponding ZRE-node
		 */
		this.zreReflectionsOfWampNodes = new Map()
		/**
		 * A dictionary that maps a WAMP topic URI to the number of ZRE peers subscribed to this topic
		 */
		this.numberOfZrePeersForWampTopic = new Map()

		const  onZreNetwork = this.zreObserverNode.start()
		const onWampNetwork = new Promise(enterWampNetwork => {
			this.wampObserverNode.onopen = session => enterWampNetwork()
			this.wampObserverNode.open()
		})

		this.onReady = Promise.all([onZreNetwork, onWampNetwork]).then(() => {
			this.observeZreNetwork()
			return this.observeWampNetwork()
		})

		this.onReady.then(() => this.emit('ready'))
	}

	observeZreNetwork() {
		this.zreObserverNode.setEncoding(null)
		this.zreObserverNode.on('whisper', (senderID, name, buffer) => {
			const {uri, argument, id} = msgpack.decode(buffer)
			let args, kwArgs
			if (argument instanceof Array) {
				args = argument
			} else {
				args = []
				kwArgs = argument
			}
			this.wampObserverNode.session.call(uri, args, kwArgs).then(result => {
				this.zreObserverNode.whisper(
					senderID,
					msgpack.encode({
						type: 'WAMP RPC result',
						id,
						result
					})
				)
			}).catch(error => {
				this.zreObserverNode.whisper(
					senderID,
					msgpack.encode({
						type: 'WAMP RPC result',
						id,
						error
					})
				)
			})
		})

		const prefixLength = Bridge.getSubscriptionGroupPrefix().length
		this.zreObserverNode.on('join', (id, name, group) => {
			if (group.slice(0,prefixLength) === Bridge.getSubscriptionGroupPrefix()) {
				const topic = group.slice(prefixLength)
				const oldNumber = this.numberOfZrePeersForWampTopic.get(topic)
				if (oldNumber >= 1) {
					this.numberOfZrePeersForWampTopic.set(topic, oldNumber+1)
				} else {
					this.wampObserverNode.session.subscribe(topic, (args,kwargs, details) => {
						let message
						if (args instanceof Array && args.length>0) {
							message = msgpack.encode(args)
						} else if (kwargs instanceof Object) {
							message = msgpack.encode(kwargs)
						} else {
							message = msgpack.encode([])
						}

						let shouter
						const publisherReflection = this.zreReflectionsOfWampNodes.get(details.publisher)
						if (details.publisher !== undefined && publisherReflection !== undefined) {
							shouter = publisherReflection
						} else {
							shouter = this.zreObserverNode
						}
						shouter.shout(group, message)
					})
				}
			}
		})
		this.zreObserverNode.on('leave', (id, name, group) => {
			if (group.slice(0,prefixLength) === Bridge.getSubscriptionGroupPrefix()) {
				const topic = group.slice(prefixLength)
				const oldNumber = this.numberOfZrePeersForWampTopic.get(topic)
				if (oldNumber > 1) {
					this.numberOfZrePeersForWampTopic.set(topic, oldNumber - 1)
				} else if (oldNumber === 1) {
					this.numberOfZrePeersForWampTopic.delete(topic)
					const subscription = this.wampObserverNode.session.subscriptions.find(s => s.topic === topic)
					this.wampObserverNode.session.unsubscribe(subscription)
				}
			}
		})

		this.zreObserverNode.join(Bridge.getOutgoingPublicationGroup())
		this.zreObserverNode.on('shout', (id, name, buffer, group) => {
			if (group === Bridge.getOutgoingPublicationGroup()) {
				const [topic, message] = msgpack.decode(buffer)
				let args, kwArgs
				if (message instanceof Array) {
					args = message
				} else if (message instanceof String || message instanceof Number) {
					args = [message]
				} else if (message instanceof Object) {
					args = []
					kwArgs = message
				} else {
					args = [message]
				}

				const reflection = this.wampReflectionsOfZreNodes.get(id)
				const session = (reflection === undefined) ? this.wampObserverNode.session : reflection.session
				session.publish(topic, args, kwArgs)
			} else {

			}
		})

		this.zreObserverNode.on('connect', (id, name, headers) => {
			if (this.zreObserverNode.getIdentity() === id) return
			// If this is a ZRE reflection of a WAMP node then return
			for (let node of this.zreReflectionsOfWampNodes.values())
				if (node.getIdentity() === id) return
			// Else make a WAMP reflection of the ZRE-node
			const wampReflection = new Autobahn.Connection(this.wampEndpoint)
			this.wampReflectionsOfZreNodes.set(id, wampReflection)
			wampReflection.onopen = session => {
				session.register(Bridge.getWhisperURI(id), ([message], argumentObject, details) => {
					return new Promise((resolve, reject) => {
						if (details.caller === undefined) {
							this.zreObserverNode.whisper(id, message)
							resolve()
						} else {
							reject('Sending from zyre reflection not implemented')
						}
					})
				})

				session.register(Bridge.getZrePeerIdURI(session.id), () => [id])
			}
			wampReflection.open()
		})

		this.zreObserverNode.on('disconnect', id => {
			const reflection = this.wampReflectionsOfZreNodes.get(id)
			if (reflection !== undefined) {
				const closeError = reflection.close()
				if (closeError === undefined) {
					this.wampReflectionsOfZreNodes.delete(id)
				}
			}
		})
	}

	observeWampNetwork() {
		// Listen to the shout topic and shout its messages into the zyre network
		const shoutObserver = this.wampObserverNode.session.subscribe(Bridge.getShoutUriPrefix(), ([message], _, details) => {
			console.log('received shout request on URI', details.topic)
			const group = Bridge.getGroupFromShoutURI(details.topic)
			this.zreObserverNode.shout(group, message)
		}, {match: 'prefix'})

		// Create ZRE reflections for incoming WAMP-clients
		const joinObserver = this.wampObserverNode.session.subscribe('wamp.session.on_join' , ([details]) => {
			if (this.wampObserverNode.session.id === details.session) return
			// If this is a WAMP reflection of a ZRE node return
			for (let node of this.wampReflectionsOfZreNodes.values())
				if (node.session !== undefined && node.session.id === details.session) return
			// Else create reflection
			const zreReflection = new Zyre({
				name: `Reflection of WAMP session: ${details.session}`,
				headers: {
					[Bridge.getWAMPsessionIdHeaderKey()]: details.session
				}
			})
			this.zreReflectionsOfWampNodes.set(details.session, zreReflection)
			zreReflection.on('whisper', (id, name, message)=>{
				//Todo
			})
			zreReflection.start().then(() => {
				for (let group of this.zreReflectionGroups) {
					zreReflection.join(group)
				}
			})
		})

		const leaveObserver = this.wampObserverNode.session.subscribe('wamp.session.on_leave', ([leavingSessionID]) => {
			const reflection = this.zreReflectionsOfWampNodes.get(leavingSessionID)
			if (reflection !== undefined) {
				reflection.stop().then(() => {
					this.zreReflectionsOfWampNodes.delete(leavingSessionID)
				})
			}
		})

		return Promise.all([shoutObserver, joinObserver, leaveObserver])
	}

	destroy() {
		const wampObserverClosed = new Promise((resolve) => {
			this.wampObserverNode.onclose = () => resolve()
			this.wampObserverNode.close()
		})
		const zreObserverClosed = this.zreObserverNode.stop()

		const nodesClosed = [wampObserverClosed, zreObserverClosed]
		for (let node of this.wampReflectionsOfZreNodes.values()) {
			nodesClosed.push(new Promise(function (resolve) {
				node.onclose = function() {
					resolve()
				}

				// Not sure why this timeout is needed
				// but autobahn shows the following warning when no timeout is used:
				//  > failing transport due to protocol violation: unexpected message type 8
				setTimeout(()=>node.close(), 20)
			}))
		}
		for (let node of this.zreReflectionsOfWampNodes.values()) {
			nodesClosed.push(node.stop())
		}
		return Promise.all(nodesClosed)
	}

	static getShoutUriPrefix() {
		return 'ZRE-Bridge.shout.out'
	}

	static getShoutURI(zreGroup) {
		return Bridge.getShoutUriPrefix() + '.' + Bridge.encodeURI(zreGroup)
	}

	static getGroupFromShoutURI(uri) {
		return Bridge.decodeURI(uri.slice(Bridge.getShoutUriPrefix().length + 1))
	}

	static getPublicationURI() {
		return 'ZRE-Bridge.shout.in'
	}

	static getOutgoingPublicationGroup() {
		return 'WAMP publications'
	}

	static getSubscriptionGroupPrefix() {
		return 'WAMP subscription:'
	}

	static getSubscriptionGroup(topicURI) {
		return Bridge.getSubscriptionGroupPrefix() + topicURI
	}

	static getWhisperURI(peerID) {
		return `ZRE-Bridge.peer.${peerID}.whisper`
	}

	static getZrePeerIdURI(sessionID) {
		return `ZRE-Bridge.wamp-session.${sessionID}.get-zre-peer-id`
	}

	static getWAMPsessionIdHeaderKey() {
		return `WAMP-sesion-id`
	}

	static getVersion() {
		return '1.0.0'
	}

	static getVersionHeaderKey() {
		return 'WAMP-bridge-version'
	}

	static encodeURI(string) {
		return string.replace(/[\x20\x23\x25\x2e]/g, (character, offset) => "%" + string.charCodeAt(offset).toString(16))
	}

	static decodeURI(string) {
		return string.replace(/%(20|23|25|2e|2E)/g, (character, hex) => String.fromCharCode(parseInt(hex, 16)))
	}
}