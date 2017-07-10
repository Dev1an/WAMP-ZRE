/**
 * Created by damiaan on 10/07/17.
 */

const Bridge = require('./')

test('bridges local WAMP realm to ZRE network', done => {
	new Bridge({
		WAMP: {
			endpoint: {
				url: 'ws://localhost:32782/ws',
				realm: 'realm1'
			}
		},
		onReady() {
			done()
		}
	})
})