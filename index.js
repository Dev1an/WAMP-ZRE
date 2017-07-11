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
				session.register(`ZRE-bridge.${id}.whisper`, (argumentArray, argumentObject, details) => {
					return new Promise((resolve, reject) => {
						if (details.caller === undefined) {
							this.zreObserverNode.whisper(id, JSON.stringify(argumentArray))
						} else {
							reject('Sneding from zyre reflection not implemented')
						}
					})
				})
			}
			this.wampReflectionsOfZreNodes.set(id, wampReflection)
		})
	}

	observeWampNetwork() {
		this.wampObserverNode.session.subscribe('ZRE-Bridge.shout', ([group, message]) => {
			this.zreObserverNode.shout(group, message)
		})
	}

	destroy() {
		this.wampObserverNode.close()
		this.zreObserverNode.stop()
		for (let node of this.wampReflectionsOfZreNodes.values()) {
			node.close()
		}
	}
}