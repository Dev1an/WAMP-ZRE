[![CircleCI](https://circleci.com/gh/Dev1an/WAMP-ZRE.svg?style=svg)](https://circleci.com/gh/Dev1an/WAMP-ZRE)

# Usage
`npm install Dev1an/WAMP-ZRE`

```js
const Bridge = require('wamp-zre')
new Bridge({
  WAMP: {
    url: 'ws://localhost:8080/ws',
    realm: 'realm1'
  }
})
```
