/**
 * Created by damiaan on 10/07/17.
 */
jasmine.DEFAULT_TIMEOUT_INTERVAL = 18000

const Bridge = require('./')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')

const wampEndpoint = {
	url: 'ws://localhost:8080/ws',
	realm: 'realm1'
}
const bridge = new Bridge({WAMP: {endpoint: wampEndpoint} })

afterAll(() => {
	return bridge.destroy()
})

test('Bridge connects to both networks', done => {
	bridge.onReady.then(() => done())
})

describe('Send WAMP messages to ZRE network', () => {
	const zreNode = Zyre.new({name: 'node 1'})
	const wampNode = new Autobahn.Connection(wampEndpoint)

	beforeAll(() => new Promise(resolve => {
		bridge.onReady.then(() => {
			const wampNodeReady = new Promise(resolve => {
				wampNode.onopen = session => resolve(session)
				wampNode.open()
			}).then(session => {
				return new Promise(resolve => {
					const subscription = session.subscribe('wamp.registration.on_create', ([session, registration]) => {
						console.log(registration)
						if (registration.uri === Bridge.getWhisperURI(zreNode.getIdentity())) {
							resolve()
							session.unsubscribe(subscription)
						}
					})
				})
			})
			const zreNodeReady  = zreNode.start()
			Promise.all([zreNodeReady, wampNodeReady]).then(() => resolve())
		})
	}))
	afterAll(() => {
		wampNode.close()
		zreNode.stop()
	})

	test('Shout from WAMP to ZRE node', done => {
		const testGroup = 'org.devian.shout-test.&@/=+°';
		const testMessage = 'My special shout test message'

		zreNode.join(testGroup)
		zreNode.on('shout', (id, name, message, group) => {
			if (group == testGroup) {
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
				if (group == testGroup) {
					expect(message).toEqual(testMessage)
					resolve()
				}
			})
		})

		const zreNode2 = Zyre.new({name: 'node 2'})
		const secondNodeReceived = new Promise(resolve => {
			const timeout = setTimeout(() => zreNode2.stop(), jasmine.DEFAULT_TIMEOUT_INTERVAL)
			zreNode2.start(() => {
				setTimeout(() => zreNode2.join(testGroup), 10)
				zreNode2.on('shout', (id, name, message, group) => {
					if (group == testGroup) {
						expect(message).toEqual(testMessage)
						clearTimeout(timeout)
						zreNode2.stop()
						resolve()
					}
				})
			})
		})

		zreNode.on('join', (id, name, group) => {
			if (id == zreNode2.getIdentity() && group == testGroup) {
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