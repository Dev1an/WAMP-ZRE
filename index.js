const EventEmitter = require('events')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')

module.exports = class Bridge extends EventEmitter {
	constructor({WAMP: {endpoint: wampEndpoint}, ZRE: {reflectionGroups = ['WAMP-Bridge reflections']}}) {
		super();
		this.wampEndpoint = wampEndpoint // format {url: String, realm: String}
		this.zreReflectionGroups = reflectionGroups

		this.zreObserverNode = Zyre.new({name: 'WAMP Bridge'})
		this.wampObserverNode = new Autobahn.Connection(this.wampEndpoint)

		/**
		 * A dictionary that maps a ZRE-node's ID to its coresponding Autobahn connection.
		 */
		this.wampReflectionsOfZreNodes = new Map()
		/**
		 * A dictionary that maps a WAMP-node's current session ID to its corresponding ZRE-node
		 */
		this.zreReflectionsOfWampNodes = new Map()

		const  onZreNetwork = this.zreObserverNode.start()
		const onWampNetwork = new Promise(enterWampNetwork => {
			this.wampObserverNode.onopen = session => enterWampNetwork()
			this.wampObserverNode.open()
		})
		this.onReady = Promise.all([onZreNetwork, onWampNetwork])
		this.onReady.then(() => {
			this.observeWampNetwork()
			this.observeZreNetwork()
			this.emit('ready')
		})
	}

	observeZreNetwork() {
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
		this.wampObserverNode.session.subscribe(Bridge.getShoutURI(), ([group, message]) => {
			this.zreObserverNode.shout(group, message)
		})

		// Create ZRE reflections for incoming WAMP-clients
		this.wampObserverNode.session.subscribe('wamp.session.on_join' , ([details]) => {
			if (this.wampObserverNode.session.id === details.session) return
			// If this is a WAMP reflection of a ZRE node return
			for (let node of this.wampReflectionsOfZreNodes.values())
				if (node.session !== undefined && node.session.id === details.session) return
			// Else create reflection
			const zreReflection = new Zyre({name: `Reflection of WAMP session: ${details.session}`})
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

		this.wampObserverNode.session.subscribe('wamp.session.on_leave', ([leavingSessionID]) => {
			const reflection = this.zreReflectionsOfWampNodes.get(leavingSessionID)
			if (reflection !== undefined) {
				reflection.close().then(() => {
					this.zreReflectionsOfWampNodes.delete(leavingSessionID)
				})
			}
		})
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

	static getShoutURI() {
		return 'ZRE-Bridge.shout'
	}

	static getWhisperURI(peerID) {
		return `ZRE-Bridge.peer.${peerID}.whisper`
	}

	static getZrePeerIdURI(sessionID) {
		return `ZRE-Bridge.wamp-session.${sessionID}.get-zre-peer-id`
	}
}