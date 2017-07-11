const EventEmitter = require('events')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')

module.exports = class Bridge extends EventEmitter {
	constructor({WAMP: {endpoint: wampEndpoint}}) {
		super();
		this.wampEndpoint = wampEndpoint // format {url: String, realm: String}

		this.zreObserverNode = Zyre.new({name: 'WAMP Bridge'})
		this.wampObserverNode = new Autobahn.Connection(this.wampEndpoint)

		/**
		 * A dictionary that maps a ZRE-node's ID to its coresponding Autobahn connection.
		 */
		this.wampReflectionsOfZreNodes = new Map()
		this.zreReflectionsOfWampNodes = []

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
			const wampReflection = new Autobahn.Connection(this.wampEndpoint)
			wampReflection.onopen = session => {
				session.register(Bridge.getWhisperURI(id), ([message], argumentObject, details) => {
					return new Promise((resolve, reject) => {
						if (details.caller === undefined) {
							this.zreObserverNode.whisper(id, message)
						} else {
							reject('Sending from zyre reflection not implemented')
						}
					})
				})
			}
			wampReflection.open()
			this.wampReflectionsOfZreNodes.set(id, wampReflection)
		})
	}

	observeWampNetwork() {
		this.wampObserverNode.session.subscribe(Bridge.getShoutURI(), ([group, message]) => {
			this.zreObserverNode.shout(group, message)
		})
	}

	destroy() {
		this.wampObserverNode.close()
		this.zreObserverNode.stop()
		const reflectionsClosed = []
		for (let node of this.wampReflectionsOfZreNodes.values()) {
			reflectionsClosed.push(new Promise(function (resolve) {
				node.onclose = function() {
					resolve()
				}

				// Not sure why this timeout is needed
				// but autobahn shows the following warning when no timeout is used:
				//  > failing transport due to protocol violation: unexpected message type 8
				setTimeout(()=>node.close(), 20)
			}))
		}
		return Promise.all(reflectionsClosed)
	}

	static getShoutURI() {
		return 'ZRE-Bridge.shout'
	}

	static getWhisperURI(peerID) {
		return `ZRE-Bridge.peer.${peerID}.whisper`
	}
}