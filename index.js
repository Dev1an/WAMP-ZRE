const EventEmitter = require('events')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')
const msgpack = require("msgpack-lite");

module.exports = class Bridge extends EventEmitter {
	constructor({WAMP: {endpoint: wampEndpoint}, ZRE: {reflectionGroups = ['WAMP-Bridge reflections'], zreEndpoint = {}}}) {
		super();
		this.wampEndpoint = wampEndpoint // format {url: String, realm: String}
		this.zreObserverEndpoint = zreEndpoint
		this.zreReflectionEndpoint = zreEndpoint
		this.zreReflectionGroups = reflectionGroups

		this.zreObserverEndpoint.name = 'WAMP Bridge'
		if (this.zreObserverEndpoint.headers === undefined) this.zreObserverEndpoint.headers = {}
		this.zreObserverEndpoint.headers[Bridge.getVersionHeaderKey()] = Bridge.getVersion()

		this.zreObserverNode = Zyre.new(this.zreObserverEndpoint)
		this.wampObserverNode = new Autobahn.Connection(this.wampEndpoint)

		/**
		 * A dictionary that maps a ZRE-node's ID to its corresponding Autobahn connection.
		 * @type {Map<string, Autobahn#Connection>}
		 */
		this.wampReflectionsOfZreNodes = new Map()
		/**
		 * A dictionary that maps a WAMP-node's current session ID to its corresponding ZRE-node
		 * @type {Map<string, Zyre>}
		 */
		this.zreReflectionsOfWampNodes = new Map()
		/**
		 * A dictionary that maps a WAMP topic URI to the number of ZRE peers subscribed to this topic
		 */
		this.numberOfZrePeersForWampTopic = new Map()

		const  onZreNetwork = this.zreObserverNode.start()
		const onWampNetwork = new Promise(enterWampNetwork => {
			this.wampObserverNode.onopen = session => {
				session.call('wamp.session.list').then(sessionIDs => {
					for (let id of sessionIDs) {
						this.createZreReflectionFor(id)
					}
				})
				enterWampNetwork()
			}
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
			const [options, procedure, arrayData, objectData, id] = msgpack.decode(buffer)
			this.wampObserverNode.session.call(procedure, arrayData, objectData, options).then(result => {
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
				const reflection = this.wampReflectionsOfZreNodes.get(id)
				const session = (reflection === undefined) ? this.wampObserverNode.session : reflection.session
				const byteArray = Array.prototype.slice.call(buffer, 0)
				session.publish(Bridge.getPublicationTopicForGroup(group), byteArray)
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
				session.register(Bridge.getWhisperURI(id), (byteArray, argumentObject, details) => {
					return new Promise(resolve => {
						let zreNode
						if (details.caller !== undefined) zreNode = this.zreReflectionsOfWampNodes.get(details.caller)
						if (zreNode === undefined) zreNode = this.zreObserverNode
						zreNode.whisper(id, new Buffer(byteArray))
						resolve()
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

	createZreReflectionFor(wampSessionID) {
		if (this.wampObserverNode.session.id === wampSessionID) return
		// If this is a WAMP reflection of a ZRE node return
		for (let node of this.wampReflectionsOfZreNodes.values())
			if (node.session !== undefined && node.session.id === wampSessionID) return
		// Else create reflection
		const zreReflection = new Zyre({
			name: `Reflection of WAMP session: ${wampSessionID}`,
			headers: {
				[Bridge.getWAMPsessionIdHeaderKey()]: wampSessionID
			},
			iface: this.zreReflectionEndpoint.iface,
			evasive: this.zreReflectionEndpoint.evasive,
			expired: this.zreReflectionEndpoint.expired,
			bport: this.zreReflectionEndpoint.bport,
			binterval: this.zreReflectionEndpoint.binterval,
		})
		this.zreReflectionsOfWampNodes.set(wampSessionID, zreReflection)
		zreReflection.start().then(() => {
			for (let group of this.zreReflectionGroups) {
				zreReflection.join(group)
			}
		})
	}

	observeWampNetwork() {
		// Listen to the shout topic and shout its messages into the zyre network
		const shoutObserver = this.wampObserverNode.session.subscribe(Bridge.getShoutUriPrefix(), (byteArray, _, details) => {
			const group = Bridge.getGroupFromShoutURI(details.topic)

			let zreNode
			if (details.publisher !== undefined) zreNode = this.zreReflectionsOfWampNodes.get(details.publisher)
			if (zreNode === undefined) zreNode = this.zreObserverNode

			zreNode.shout(group, new Buffer(byteArray))
		}, {match: 'prefix'})

		// Create ZRE reflections for incoming WAMP-clients
		const joinObserver = this.wampObserverNode.session.subscribe('wamp.session.on_join' , ([details]) => {
			this.createZreReflectionFor(details.session)
		})

		const leaveObserver = this.wampObserverNode.session.subscribe('wamp.session.on_leave', ([leavingSessionID]) => {
			const reflection = this.zreReflectionsOfWampNodes.get(leavingSessionID)
			if (reflection !== undefined) {
				reflection.stop().then(() => {
					this.zreReflectionsOfWampNodes.delete(leavingSessionID)
				})
			}
		})

		const subscriptionObserver = this.wampObserverNode.session.subscribe('wamp.subscription.on_create', ([sessionID, subscription]) => {
			if (subscription.uri.slice(0, Bridge.getPublicationTopicPrefix().length) === Bridge.getPublicationTopicPrefix()) {
				const group = Bridge.getGroupFromPublicationTopic(subscription.uri)
				this.zreObserverNode.join(group)
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

	static getPublicationTopicPrefix() {
		return 'ZRE-Bridge.shout.in'
	}

	static getPublicationTopicForGroup(group) {
		return Bridge.getPublicationTopicPrefix() + '.' + Bridge.encodeURI(group)
	}

	static getGroupFromPublicationTopic(topic) {
		return Bridge.decodeURI(topic.slice(Bridge.getPublicationTopicPrefix().length + 1))
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