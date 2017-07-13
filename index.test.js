/**
 * Created by damiaan on 10/07/17.
 */
jasmine.DEFAULT_TIMEOUT_INTERVAL = 18000

const EventEmitter = require('events')
const Bridge = require('./')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')
const testHelpers = require('./lib/test-helpers')

const wampEndpoint = {
	url: 'ws://localhost:8080/ws',
	realm: 'realm1'
}
const bridge = new Bridge({
	WAMP: {endpoint: wampEndpoint},
	ZRE: {}
})

afterAll(() => {
	return bridge.destroy()
})

test('Bridge connects to both networks', done => {
	bridge.onReady.then(() => done())
})

describe('Reflection lifecycle', () => {
	describe('WAMP reflection lifecycle', () => {
		const wampClient = new Autobahn.Connection(wampEndpoint)
		const metaManager = new EventEmitter()
		beforeAll(() => {
			const subscriptionsReady = new Promise(resolve => {
				wampClient.onopen = session => resolve(session)
			}).then(session => Promise.all([
				session.subscribe('wamp.session.on_join' , ([details]) => metaManager.emit( 'join', details)),
				session.subscribe('wamp.session.on_leave', ([details]) => metaManager.emit('leave', details))
			]))
			wampClient.open()

			return subscriptionsReady
		})
		afterAll(() => new Promise(resolve => {
			wampClient.onclose = () => resolve()
			wampClient.close()
		}))
		afterEach(() => metaManager.removeAllListeners())

		test('Reflection is created after a ZRE node enters', done => {
			const zreNode = new OneTestZyre()
			metaManager.on('join', details => {
				const zreNodeID = zreNode.getIdentity()
				wampClient.session.call(Bridge.getZrePeerIdURI(details.session)).then(([peerID]) => {
					if (peerID === zreNodeID) {
						zreNode.stop()
						done()
					}
				})
			})
			zreNode.start()
		})

		test('Reflection is closed after ZRE node leaves', done => {
			const zreNode = new OneTestZyre()
			let sessionID
			metaManager.on('join', details => {
				const zreNodeID = zreNode.getIdentity()
				wampClient.session.call(Bridge.getZrePeerIdURI(details.session)).then(([peerID]) => {
					if (peerID === zreNodeID) {
						sessionID = details.session
						zreNode.stop()
					}
				})
			})
			metaManager.on('leave', leavingSession => {
				if (leavingSession === sessionID) {
					done()
				}
			})
			zreNode.start()
		})
	})

	describe('ZRE reflection lifecycle', () => {
		const zreObserver = new Zyre({name: 'observer for ZRE reflection lifecycle test'})
		beforeAll(() => zreObserver.start())
		afterAll(()  => zreObserver.stop())
		afterEach(() => zreObserver.removeAllListeners())

		test('Reflection is created for each wamp session', done => {
			const wampConnection = new OneTestAutobahnConnection(wampEndpoint);

			zreObserver.on('connect', (id, name, headers) => {
				if (headers[Bridge.getWAMPsessionIdHeaderKey()] == wampConnection.session.id) {
					wampConnection.onclose = () => done()
					wampConnection.stop()
				}
			})

			wampConnection.open()
		})

		test('Reflection is stopped after WAMP session ends', done => {
			const wampConnection = new OneTestAutobahnConnection(wampEndpoint);

			let zreNodeID
			zreObserver.on('connect', (id, name, headers) => {
				if (headers[Bridge.getWAMPsessionIdHeaderKey()] == wampConnection.session.id) {
					zreNodeID = id
					wampConnection.stop()
				}
			})
			zreObserver.on('disconnect', id => {
				if (id === zreNodeID) done()
			})

			wampConnection.open()
		})
	})
})

describe('Communication', () => {
	const zreNode = Zyre.new({name: 'node 1'})
	const wampNode = new Autobahn.Connection(wampEndpoint)
	const promiseZreAndWamp = testHelpers.promiseZreAndWamp({wampNode, zreNode})
	beforeAll(promiseZreAndWamp.start)
	afterAll(promiseZreAndWamp.stop)

	describe('WAMP to ZRE', () => {
		test('Shout from WAMP to ZRE node', done => {
			const testGroup = 'org.devian.shout-test.&@/=+°';
			const testMessage = 'My special shout test message'

			zreNode.join(testGroup)
			zreNode.on('shout', (id, name, message, group) => {
				if (group === testGroup) {
					expect(message).toEqual(testMessage)
					done()
				}
			})

			wampNode.session.publish(Bridge.getShoutURI(), [testGroup, testMessage])
		})

		test('Shout from WAMP to multiple ZRE nodes', done => {
			const testGroup = 'org.devian.shout-test.2';
			const testMessage = 'My special broadcast message'

			const firstNodeReceived = new Promise(resolve => {
				zreNode.join(testGroup)
				zreNode.on('shout', (id, name, message, group) => {
					if (group === testGroup) {
						expect(message).toEqual(testMessage)
						resolve()
					}
				})
			})

			const zreNode2 = Zyre.new({name: 'node 2'})
			const secondNodeReceived = new Promise(resolve => {
				const timeout = setTimeout(() => zreNode2.stop(), jasmine.DEFAULT_TIMEOUT_INTERVAL)
				zreNode2.start(() => {
					zreNode2.join(testGroup)
					zreNode2.on('shout', (id, name, message, group) => {
						if (group === testGroup) {
							expect(message).toEqual(testMessage)
							clearTimeout(timeout)
							zreNode2.stop()
							resolve()
						}
					})
				})
			})

			zreNode.on('join', (id, name, group) => {
				if (id === zreNode2.getIdentity() && group === testGroup) {
					wampNode.session.publish(Bridge.getShoutURI(), [testGroup, testMessage])
				}
			})
			Promise.all([firstNodeReceived, secondNodeReceived]).then(() => done())
		})

		test('Whisper from WAMP to ZRE Node', done => {
			const testMessage = 'My special whisper message'
			zreNode.on('whisper', (id, name, message) => {
				expect(message).toEqual(testMessage)
				done()
			})

			const peerID = zreNode.getIdentity()

			wampNode.session.call(Bridge.getWhisperURI(peerID), [testMessage])
		})
	})

	describe('ZRE to WAMP', () => {

	})
})

class OneTestZyre extends Zyre {
	constructor(options) {
		super(options)

		this._testTimeout = setTimeout(() => {
			super.stop()
		}, jasmine.DEFAULT_TIMEOUT_INTERVAL)
	}

	stop() {
		clearTimeout(this._testTimeout)
		return super.stop()
	}
}

class OneTestAutobahnConnection extends Autobahn.Connection {
	constructor(options) {
		super(options)

		this._testTimeout = setTimeout(() => {
			super.close()
		}, jasmine.DEFAULT_TIMEOUT_INTERVAL)
	}

	stop() {
		clearTimeout(this._testTimeout)
		return super.close()
	}
}