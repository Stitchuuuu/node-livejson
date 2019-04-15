const LiveJSON = require('./index')
LiveJSON.VERBOSE = 0
let config = new LiveJSON({
    test: 1,
    arr2: [1,2],
    obj: {
        name: 'truc'
    },
    arr: [{
        'machin': 1
    }]
}, 'config.json')

config.on('change', function(e) {
    // console.log(`${e.fullname} changed to `, e.value)
    console.log('Test config: ', config.$.test)
})
config.on('propchange', function(e) {
    console.log(`Prop ${e.fullname} changed to `, e.value)
})

console.log(config.$)
config.$.test = 2