const Zyre = require('zyre.js')
const Autobahn = require('autobahn')

module.exports.promiseZreAndWamp = function ({wampNode, zreNode}) {
	return {
		start() {
			const wampNodeReady = new Promise(resolve => {
				wampNode.onopen = session => resolve(session)
				wampNode.open()
			})
			const zreNodeReady  = zreNode.start()
			return Promise.all([zreNodeReady, wampNodeReady])
		},

		stop() {
			wampNode.close()
			zreNode.stop()
		}
	}
}