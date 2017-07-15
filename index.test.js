/**
 * Created by damiaan on 10/07/17.
 */
jasmine.DEFAULT_TIMEOUT_INTERVAL = 18000

const EventEmitter = require('events')
const Bridge = require('./')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')
const msgpack = require("msgpack-lite");

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
				session.subscribe('wamp.registration.on_create', ([session, registration]) => metaManager.emit('register', {session, registration})),
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
			metaManager.on('register', ({session, registration: {uri}}) => {
				if (uri == Bridge.getWhisperURI(zreNode.getIdentity())) {
					zreNode.stop()
					done()
				}
			})
			zreNode.start()
		})

		test('Reflection is closed after ZRE node leaves', done => {
			const zreNode = new OneTestZyre()
			let sessionID
			metaManager.on('register', ({session, registration: {uri}}) => {
				if (uri == Bridge.getWhisperURI(zreNode.getIdentity())) {
					sessionID = session
					zreNode.stop()
				}
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

		test('Reflection is created for each wamp session', done => {
			const wampConnection = new OneTestAutobahnConnection(wampEndpoint);
			const headerKey = Bridge.getWAMPsessionIdHeaderKey()

			zreObserver.on('connect', (id, name, headers) => {
				if (wampConnection.session != null && wampConnection.session.id != null) {
					if (headers[headerKey] == wampConnection.session.id) {
						wampConnection.onclose = () => done()
						wampConnection.stop()
					}
				}
			})

			wampConnection.open()
		})

		test('Reflection is stopped after WAMP session ends', done => {
			const wampConnection = new OneTestAutobahnConnection(wampEndpoint);

			let zreNodeID
			zreObserver.on('disconnect', id => {
				if (id === zreNodeID) done()
			})
			zreObserver.on('connect', (id, name, headers) => {
				if (wampConnection.session != null && wampConnection.session.id != null) {
					if (headers[Bridge.getWAMPsessionIdHeaderKey()] == wampConnection.session.id) {
						zreNodeID = id
						wampConnection.stop()
					}
				}
			})

			wampConnection.open()
		})

		afterEach(() => {
			if (zreObserver == undefined) console.log('zre observer is undefined')
			zreObserver.removeAllListeners()
		})

		afterAll(() => {
			return zreObserver.stop().catch(error => console.log('already stopped'))
		})
	})
})

describe('Communication', () => {
	const zreNode = Zyre.new({name: 'node 1'})
	const wampNode = new Autobahn.Connection(wampEndpoint)
	beforeAll(() => {
		const wampNodeReady = new Promise(resolve => {
			wampNode.onopen = session => resolve(session)
			wampNode.open()
		})
		const zreNodeReady  = zreNode.start()
		return Promise.all([zreNodeReady, wampNodeReady]).catch(error => console.log('error while starting', error))
	})

	afterEach(() => {
		zreNode.removeAllListeners()
	})

	describe('WAMP to ZRE', () => {
		test('Shout from WAMP to ZRE node', done => {
			expect.assertions(1)
			const testGroup = 'org.devian.shout-test.&@/=+°';
			const testMessage = 'My special shout test message'

			zreNode.join(testGroup)
			zreNode.on('shout', (id, name, message, group) => {
				if (group === testGroup) {
					expect(message).toEqual(testMessage)
					done()
				}
			})

			wampNode.session.publish(Bridge.getShoutURI(testGroup), [testMessage])
		})

		test('Shout from WAMP to multiple ZRE nodes', done => {
			const testGroup = 'org.devian.shout-test.2';
			const testMessage = 'My special broadcast message'
			expect.assertions(2)

			const firstNodeReceived = new Promise(resolve => {
				zreNode.join(testGroup)
				zreNode.on('shout', (id, name, message, group) => {
					if (group === testGroup) {
						expect(message).toEqual(testMessage)
						resolve()
					}
				})
			})

			const zreNode2 = new OneTestZyre({name: 'node 2'})
			const secondNodeReceived = new Promise(resolve => {
				zreNode2.start(() => {
					zreNode2.join(testGroup)
					zreNode2.on('shout', (id, name, message, group) => {
						if (group === testGroup) {
							expect(message).toEqual(testMessage)
							zreNode2.stop()
							resolve()
						}
					})
				})
			})

			zreNode.on('join', (id, name, group) => {
				if (id === zreNode2.getIdentity() && group === testGroup) {
					wampNode.session.publish(Bridge.getShoutURI(testGroup), [testMessage])
				}
			})
			Promise.all([firstNodeReceived, secondNodeReceived]).then(() => done())
		})

		test('Whisper from WAMP to ZRE Node', done => {
			expect.assertions(1)
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
		describe('Call WAMP procedure from ZRE peer', () => {
			test('passes an array as argument', done => {
				const testURI = 'WAMP-Bridge.test.procedure.1'
				const testArguments = ['Hello', 'world']

				expect.assertions(1)

				wampNode.session.register(testURI, receivedArguments => {
					expect(receivedArguments).toEqual(testArguments)
					done()
				}).then(() => {
					zreNode.whisper(bridge.zreObserverNode.getIdentity(), msgpack.encode([
						{},
						testURI,
						testArguments
					]))
				}).catch(
					error => expect(error).toBeNull()
				)
			})

			test('passes a dictionary as argument', done => {
				const testURI = 'WAMP-Bridge.test.procedure.2'
				const testArgument = {Hello: 'world'}

				expect.assertions(1)

				wampNode.session.register(testURI, (_,receivedArgument) => {
					expect(receivedArgument).toEqual(testArgument)
					done()
				}).then(() => {
					zreNode.whisper(bridge.zreObserverNode.getIdentity(), msgpack.encode([
						{},
						testURI,
						[],
						testArgument
					]))
				}).catch(
					error => expect(error).toBeNull()
				)
			})

			test('returns a string', done => {
				const testURI = 'WAMP-Bridge.test.procedure.3'
				const testResult = "Correct result"
				const testID = 683

				expect.assertions(1)

				wampNode.session.register(testURI, () => testResult).then(() => {
					zreNode.setEncoding(null)
					zreNode.on('whisper', (senderID, name, buffer) => {
						const {type, result, id} = msgpack.decode(buffer)
						if (id === testID && senderID === bridge.zreObserverNode.getIdentity() && type === 'WAMP RPC result') {
							try {
								expect(result).toEqual(testResult)
								done()
							} catch (error) {
								done.fail(error)
							}
						}
					})
					zreNode.whisper(bridge.zreObserverNode.getIdentity(), msgpack.encode([
						{},
						testURI,
						[],
						{},
						testID
					]))
				}).catch(
					error => { done.fail(error) }
				)
			})
		})

		test('Publish message to WAMP topic', done => {
			const testTopic = 'WAMP-Bridge.test.publication.1'
			const testObject = {hello: 'world'}

			expect.assertions(1)
			wampNode.session.subscribe(testTopic, (args, kwargs) => {
				expect(kwargs).toEqual(testObject)
				done()
			}).then(() => {
				zreNode.shout(Bridge.getOutgoingPublicationGroup(), msgpack.encode([testTopic, testObject]))
			})
		})

		test('Subscribe to WAMP topic from ZRE peer', done => {
			const testTopic = 'WAMP-Bridge.test.publication.2'
			const testObject = {content: 'just a normal ZRE agnostic WAMP message'}

			expect.assertions(1)

			wampNode.session.subscribe('wamp.subscription.on_create', ([sessionID, subscription]) => {
				wampNode.session.publish(testTopic, [], testObject)
			})

			const testGroup = Bridge.getSubscriptionGroup(testTopic)
			zreNode.join(testGroup)
			zreNode.on('shout', (id, name, buffer, group) => {
				if (group === Bridge.getSubscriptionGroup(testTopic)) {
					const message = msgpack.decode(buffer)
					expect(message).toEqual(testObject)
					done()
				}
			})
		})
	})

	afterAll(() => new Promise(
		resolve => {
			setTimeout(function() {
				const wampClosed = new Promise(resolve => {
					wampNode.onclose = () => resolve()
					wampNode.close()
				})
				const zreClosed = zreNode.stop()

				Promise.all([wampClosed, zreClosed]).catch(error => console.log('error while closing', error))
					.then(() => resolve())
			}, 2000)
		}
	))
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