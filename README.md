[![CircleCI](https://circleci.com/gh/Dev1an/WAMP-ZRE.svg?style=svg)](https://circleci.com/gh/Dev1an/WAMP-ZRE)

# Usage

## Run the bridge

First install NodeJS. Then download this module using:

```bash
npm install Dev1an/WAMP-ZRE
```

Once installed, you can use the bridge in a nodejs script:

```js
const Bridge = require('wamp-zre')
new Bridge({
  WAMP: {
    url: 'ws://localhost:8080/ws',
    realm: 'realm1'
  }
})
```

## Talk to ZRE peers via WAMP

### Shout

Publish an (two-element) array containing the ZRE group (as first element) and a message (as second element) to the topic with WAMP URI: `ZRE-Bridge.shout` 

The bridge listens to this topic and shouts the messages into the ZRE network.

An **example** using Autobahn-js:

```js
const Autobahn = require('autobahn')
const wampNode = new Autobahn.Connection({
	url: 'ws://localhost:8080/ws',
	realm: 'realm1'
})
wampNode.onopen = session => {
  session.publish('ZRE-Bridge.shout', ['myZREgroup', 'hello zre group'])
}
wampNode.open()
```

### Whisper

Call the procedure with WAMP URI: `ZRE-Bridge.peer.<peerID>.whisper` (replacing `<peerID>` with the receivers peer id) with a singleton array containing your message.

When the ZRE peer with `<peerID>` entered the network the bridge registered a procedure with the coresponding WAMP URI. When this procedure is called the bridge sends a WHISPER message into the ZRE network.

An **example** using Autobahn-js:

```js
const Autobahn = require('autobahn')
const wampNode = new Autobahn.Connection({
	url: 'ws://localhost:8080/ws',
	realm: 'realm1'
})
wampNode.onopen = session => {
  session.call('ZRE-Bridge.peer.12356789abcdef.whisper', ['hello zre node'])
}
wampNode.open()
```
