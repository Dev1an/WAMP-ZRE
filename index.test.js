/**
 * Created by damiaan on 10/07/17.
 */

const Bridge = require('./')
const Zyre = require('zyre.js')
const Autobahn = require('autobahn')

const wampEndpoint = {
	url: 'ws://localhost:32782/ws',
	realm: 'realm1'
}
const bridge = new Bridge({WAMP: {endpoint: wampEndpoint} })
const cleaners = []

afterAll(() => {
	for (let clean of cleaners) {
		clean()
	}
	console.log('destroying the bridge')
	bridge.destroy()
})

test('Bridge connects to both networks', done => {
	bridge.onReady.then(() => done())
})

describe('Send WAMP messages to ZRE network', () => {
	beforeAll(() => bridge.onReady)

	test('Shout from WAMP to ZRE node', done => {
		const testGroup = 'org.devian.shout-test.&@/=+°';
		const testMessage = 'My special shout test message'

		const zreNode = Zyre.new()
		zreNode.on('shout', (id, name, message, group) => {
			if (group == testGroup) {
				expect(message).toEqual(testMessage)
				done()
			}
		})

		const wampNode = new Autobahn.Connection(wampEndpoint)
		wampNode.onopen = function(session) {
			session.publish(`ZRE-Bridge.shout`, [testGroup, testMessage])
		}

		zreNode.start().then(() => {
			zreNode.join(testGroup)
			wampNode.open()
		})

		cleaners.push(() => zreNode.stop())
		cleaners.push(() => wampNode.close())
	})
})