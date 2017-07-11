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
	const zreNode = Zyre.new()
	const wampNode = new Autobahn.Connection(wampEndpoint)

	beforeAll(() => {
		return new Promise(resolve => {
			bridge.onReady.then(() => {
				const zreNodeReady  = zreNode.start()
				const wampNodeReady = new Promise(wampNetworkOpen => {
					wampNode.onopen = session => wampNetworkOpen()
					wampNode.open()
				})
				Promise.all([zreNodeReady, wampNodeReady]).then(() => resolve())
			})
		})
	})
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

	test('Whisper from WAMP to ZRE Node', done => {
		const testMessage = 'My special whisper message'
		zreNode.on('whisper', (id, name, message) => {
			expect(message).toEqual(testMessage)
			done()
		})

		const peerID = zreNode.getIdentity()

		// Wait for the bridge to receive the ZRE ENTER message and to create a reflecion
		setTimeout(() => {
			wampNode.session.call(Bridge.getWhisperURI(peerID), [testMessage])
		}, 500)
	})
})