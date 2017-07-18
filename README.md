[![CircleCI](https://circleci.com/gh/Dev1an/WAMP-ZRE.svg?style=svg)](https://circleci.com/gh/Dev1an/WAMP-ZRE)

WAMP-ZRE Bridge is a tool that allows

- ZRE peers to send/receive messages to/from a WAMP network
- WAMP clients to send/receive messages to/from a ZRE network

# Overview

- [Usage](#usage)
  * [Run the bridge](#run-the-bridge)
  * [Discovery of ZRE peers via WAMP](#discovery-of-zre-peers-via-wamp)
  * [Talk to ZRE peers via WAMP](#talk-to-zre-peers-via-wamp)
    + [Shout](#shout)
    + [Whisper](#whisper)
    + [Join a group](#join-a-group)
    + [Sender disclosure](#sender-disclosure)
  * [Discover WAMP clients via ZRE](#discover-wamp-clients-via-zre)
  * [Talk to WAMP clients via ZRE](#talk-to-wamp-clients-via-zre)
    + [Call remote procedure](#call-remote-procedure)
      - [Return value](#return-value)
      - [Error](#error)
    + [Publish message to topic](#publish-message-to-topic)
    + [Subscribe to topic](#subscribe-to-topic)
- [Development](#development)
  * [Testing](#testing)

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
  },
  ZRE: {
    reflectionGroups: ['WAMP-Bridge reflections'] // groups every reflection will enter
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

Publish a byte array containing the message to the topic with WAMP URI:

`ZRE-Bridge.shout.out.<ZRE GROUP>` 

- Where `<ZRE GROUP>` is a string containing any UTF8 character except `#`, `.`, `%` and the space character.
- The 4 non allowed characters should be escaped as follows
  - Space becomes `%20`
  - `#` becomes `%23`
  - `%` becomes `%25`
  - `.` becomes `%2e`

The bridge listens to this topic and shouts the messages into the ZRE network.

An **example** using Autobahn-js:

```js
const Autobahn = require('autobahn')
const wampNode = new Autobahn.Connection({
	url: 'ws://localhost:8080/ws',
	realm: 'realm1'
})
wampNode.onopen = session => {
  session.publish('ZRE-Bridge.shout.out.myZREgroup', ['hello zre group'])
}
wampNode.open()
```

### Whisper

Call the procedure with WAMP URI: `ZRE-Bridge.peer.<peerID>.whisper` (replacing `<peerID>` with the receiver's peer id) with a byte array containing your message.

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
### Join a group

Subscribe to `ZRE-Bridge.shout.in.<ZRE GROUP>`. Use the same escape method as described for shouts. Messages shouted to group `<ZRE GROUP>` will be published to this topic as a byte array.

### Sender disclosure

When using a WAMP router that allows caller and publisher disclosure, whispers and shouts into the ZRE network will originate from the ZRE reflection of WAMP client that requested the whisper/shout.

## Discover WAMP clients via ZRE 

For each WAMP client that opens a session, the bridge creates a corresponding ZRE peer. These ZRE peers are referred to as "ZRE reflections" of the WAMP clients. Each ZRE reflection ENTERS the network with the following header

```JSON
{
  "WAMP-sesion-id": "xxxxxxxxxxxx"
}
```

## Talk to WAMP clients via ZRE

Apart from the reflections of WAMP sessions, the bridge also creates another peer we will refer to as the "WAMP bridge". It enters the network with the following header

```json
{
  "WAMP-bridge-version": "1.0.0"
}
```

The WAMP bridge is a ZRE peer you can use to call remote procedures.

### Call remote procedure

Whisper a MsgPack encoded array to the WAMP bridge with the following structure:

```javascript
[
  options,   // Dictionary - WAMP call options
  uri,       // String - the URI of the WAMP procedure to call
  dataArray, // Array - an array containing arguments, can be empty
  dataObject,// Distionary - an object containing arguments, can be empty
  id         // (Number|String) - A token used to differenciate return values (optional)
]
```

#### Return value

The result of a procedure call (if any) is whispered back as a MsgPack encoded dictionary with the following structure:

```javascript
{
  "type": "WAMP RPC result"
  "id": (Number|String) // Optional; the id provided in the originating request
  "result": Array|Dictionary|String|Number,
}
```

#### Error

```javascript
{
  "type": "WAMP RPC result"
  "id": (Number|String) // Optional; the id provided in the originating request
  "error": Array|Dictionary|String|Number,
}
```

### Publish message to topic

Shout a msgpack encoded array to group `WAMP publications`

- The first element must be the WAMP URI of the topic
- The second element must be the message

### Subscribe to topic

To subscribe to a WAMP topic, join the ZRE group with name: `WAMP subscription:<WAMP-URI>`

- replace `<WAMP-URI>` with the URI of the topic to subscribe to.
- All messages published to topic `<WAMP-URI>` are shouted in this ZRE group.

### Register custom wamp procedures

It is also possible to register WAMP procedures from a ZRE node. This can be accomplished using 

# Development

Information for developers of the bridge module.

## Testing

When testing the module locally make sure you have a WAMP router running on port 8080.

Currently only one bridge is allowed to exist in the same network.