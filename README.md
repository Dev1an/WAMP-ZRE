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

## Discovery of ZRE peers via WAMP

For each ZRE peer that enters the network, the bridge creates a corresponding WAMP client. These wamp clients are referred to as "WAMP reflections" of the ZRE peers. Each WAMP reflection registers two procedures:

- `ZRE-Bridge.peer.<peerID>.whisper` used to whisper to ZRE (further discussed in [whisper](#whisper))
  - `<peerID>` the ID of the ZRE peer.
- `ZRE-Bridge.wamp-session.<sessionID>.get-zre-peer-id` returns a singleton array containing the ID of the ZRE peer that this session reflects. 
  - `sessionID` the ID of the WAMP session.

To discover ZRE peers use the standard wamp [Registration meta](https://github.com/wamp-proto/wamp-proto/blob/master/rfc/text/advanced/ap_rpc_registration_meta_api.md) and [Session meta](https://github.com/wamp-proto/wamp-proto/blob/master/rfc/text/advanced/ap_session_meta_api.md) API's.

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
  session.call('ZRE-Bridge.peer.12356789abcdef.whisper', ['hello zre peer'])
}
wampNode.open()
```
## Discover WAMP clients via ZRE 

Todo

## Talk to WAMP clients via ZRE

Todo

# Development

Information for developers of the bridge module.

## Testing

When testing the module locally make sure you have a WAMP router running on port 8080.