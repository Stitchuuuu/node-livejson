const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

/**
 * Log function
 * Will only log if Verbose > 1
 * @param  {...any} args
 */
function log(...args) {
    if (module.exports.VERBOSE) {
        console.log.apply(console, args)
    }
}
log.$2 = function(...args) {
    if (module.exports.VERBOSE >= 2) {
        log.apply(console, args)
    }
}
log.$3 = function(...args) {
    if (module.exports.VERBOSE >= 3) {
        log.apply(console, args)
    }
}
/**
 * Object corresponding to all objects in JSON
 * Returns a proxy so we know when properties are changed
 */
class LiveJSONObjectProp {
    
    constructor(props, path, onSet, onGet) {
        // The props of the objects
        this.properties = props
        
        // The current path in the original JSON
        this.path = path
        let $this = this
        log.$3(`> Creating proxy for "${path}" with :`, props)
        return new Proxy(props, {
            get: function (target, name) {
                let val
                log.$3(`> Accessing "${typeof name === 'symbol' ? 'symbol' : name}" (${typeof name}) in :`, target)
                
                // Symbol is for NodeJS console.log / console.error
                if (typeof name === 'symbol' && String(name) === 'Symbol(util.inspect.custom)') {
                    // super hacky method of supporting nodejs printing values
                    val = () => $this.properties
                } else if (typeof target[name] === 'function' && name === 'toString') {
                    // toString is the only method we are allowing
                    val = target[name]
                } else if (Array.isArray(target)) {
                    // The object is an array, special treatment to know when a value is changed in the array
                    if (typeof target[name] === 'function') {
                        
                        // We transform each function and we check the array after the execution
                        val = function (...args) {
                            let oldValue = target.slice()
                            let result = target[name].apply(target, args)
                            let _path = $this.path
                            let targetName, targetFullpath
                            
                            // Correct property name and fullpath
                            if (_path === null) {
                                targetName = null
                                targetFullpath = null
                            } else {
                                targetFullpath = _path
                                _path = _path.split(/\./gi)
                                targetName = _path.pop()
                            }
                            // Executed when a value is changed, removed, or added
                            function ArrayValueChanged(target, name, index, old, val) {
                                let oldValue, newValue
                                let removed = false
                                let added = false
                                
                                // No index on old, it is a new value
                                if (typeof old[index] !== 'undefined') {
                                    oldValue = old[index]
                                } else {
                                    added = true
                                }
                                
                                // No index on new, a value was removed
                                if (typeof val[index] !== 'undefined') {
                                    newValue = val[index]
                                } else {
                                    removed = true
                                }
                                
                                // Emit prop value change for array
                                onSet({
                                    target: target,
                                    name: targetName,
                                    index: index,
                                    oldValue: oldValue,
                                    value: newValue,
                                    removed: removed,
                                    added: added,
                                    type: 'arrayvalue',
                                    fullpath: targetFullpath
                                })
                            }
                            
                            // Checking target and oldValue values
                            let changed = false
                            target.forEach((val, index) => {
                                if (typeof oldValue[index] === 'undefined' || target[index] !== oldValue[index]) {
                                    ArrayValueChanged(target, name, index, oldValue, target)
                                    changed = true
                                }
                            })
                            oldValue.forEach((val, index) => {
                                if (typeof target[index] === 'undefined') {
                                    ArrayValueChanged(target, name, index, oldValue, target)
                                    changed = true
                                }
                            })
                            // If we have a change, we emit another event 'array', so we can tell "all the array was changed" and save only one time the file
                            if (changed) {
                                onSet({
                                    target: target,
                                    name: targetName,
                                    oldValue: oldValue,
                                    value: target.slice(),
                                    type: 'array',
                                    fullpath: targetFullpath
                                })
                            }
                            return result
                        }
                    } else {
                        // If the target is an object, we create a new proxy object on the go
                        val = target[name]
                        if (typeof val === 'object') {
                            let o = new LiveJSONObjectProp(val, $this._combine($this.path, name), onSet, onGet)
                            val = o
                        }
                    }
                } else {
                    /* Maybe it will be useful a day
                    if (onGet) {
                        val = onGet({
                            target: target,
                            name: name, 
                            path: $this.path,
                            fullpath: $this._combine($this.path, name)
                        })
                    }
                    */
                    if (typeof val === 'undefined') {
                        val = $this.properties[name]
                        if (typeof val === 'object') {
                            let o = new LiveJSONObjectProp(val, $this._combine($this.path, name), onSet, onGet)
                            val = o
                        }
                    }
                }
                return val
            },
            set: function (target, name, value) {
                let oldValue = $this.properties[name]
                let newRawValue = value
                let newValue = value
                
                // If the new value is an object, we create the proxy object on it and we return this object
                if (value === 'object') {
                    newValue = new LiveJSONObjectProp(newValue, $this._combine($this.path, name), onSet, onGet)
                }
                target[name] = value
                
                // Emitting value change
                onSet({
                    target: target,
                    name: name, 
                    path: $this.path,
                    value: newRawValue,
                    oldValue: oldValue,
                    type: 'value',
                    fullpath: $this._combine($this.path, name)
                })
                return newValue
            }
        })
    }
    
    /**
     * Combine a path and a name with '.'
     * @param {String} _path 
     * @param {String} name 
     */
    _combine(_path, name) {
        if (!_path) {
            return name
        } else {
            return _path + '.' + name
        }
    }
    
    toString() {
        return JSON.stringify(this.properties)
    }
    
}

/**
 * LiveJSON class to have an object which corresponds to a JSON file
 * The file is watched, and all changes are saved to the file directly
 * If the file is changed on the outside, the values are changed too on the object
 * 
 * Useful to have a config file and to not have to restart script
 */
class LiveJSON extends EventEmitter {
    
    /**
     * Create a new LiveJSON
     * Ex:
        new LiveJSON(require.resolve('config.json'))
        new LiveJSON({
           'file': require.resolve('config.json'),
           'autosave': false
        })
        new LiveJSON({
            user: 'myuser',
            password: 'passsword'
        }, require.resolve('config.json'))
        new LiveJSON({
            user: 'myuser',
            password: 'passsword'
        }, {
            file: require.resolve('config.json'),
            spacer: 4,
            encoding: 
        })
     * @param  {...any} args 
     */
    constructor (...args) {
        super()
        this._errorsAtStart = []
        this._created = false
        this.on('newListener', (name, listener) => {
            if (name === 'error' && this._errorsAtStart.length) {
                this._errorsAtStart.forEach((err) => {
                    listener.apply(this, [err, err.originalError])
                })
                this._errorsAtStart = []
            }
        })
        let opts, data = {}
        if (args.length === 2) {
            if (typeof args[1] === 'object' || typeof args[1] === 'string') {
                opts = args[1]
                data = args[0]
            } else if (args[1] === true) {
                data = args[0]
            }
        } else {
            opts = args[0]
        }
        let file = null
        if (typeof opts === 'string') {
            file = opts
            opts = null            
        }
        let options = Object.assign({
            file: file,
            autosave: true,
            autoload: true,
            spacer: 2,
            encoding: null
        }, opts)
        if (!file) {
            options.autosave = options.autoload = false
        }
        
        this.file = file
        this.options = options
        this.lastFileStat = false
        this._val = null
        if (fs && this.file && !fs.existsSync(this.file)) {
            this.file = path.join(path.dirname(module.parent.filename), this.file)
        } else {
            this.file = path.resolve(this.file)
        }
        // Only if we have FS (are you using CommonJS?)
        if (fs && this.file) {
            if (fs.existsSync(this.file)) {
                // Testing file writeable/readable
                let perms = fs.constants.R_OK
                let hasError = false
                if (this.options.autosave) {
                    perms = fs.constants.R_OK | fs.constants.W_OK
                }
                try {
                    fs.accessSync(this.file, perms)
                } catch (err) {
                    if (perms === fs.constants.R_OK) {
                        this._error(`File ${this.file} is not readable !`)
                    } else {                        
                        this._error(`File ${this.file} is not readable/writeable !`)
                    }
                    hasError = true
                }
                // Testing JSON
                if (!hasError) {
                    try {
                        this.lastFileStat = fs.statSync(this.file)
                        // Overriding data with contents of file
                        data = JSON.parse(fs.readFileSync(this.file, { encoding: this.options.encoding }))
                    } catch (e) {
                        this._error(`File ${file} couldn't be read as JSON. Error: ${e.message}`, e)
                    }
                }
                
                // Autoloading on change
                if (options.autoload) {
                    
                    fs.watch(path.dirname(this.file), (eventType, filename) => {
                        let filepath = path.join(path.dirname(this.file), filename)
                        if (filepath === this.file && fs.existsSync(this.file)) {
                            let stat = fs.statSync(this.file)
                            if (stat.mtime > this.lastFileStat.mtime) {
                                log(`> Watch Event: ${eventType} ${filename} must reload`)
                                this.lastFileStat = stat
                                try {
                                    let o = JSON.parse(fs.readFileSync(this.file, { encoding: this.options.encoding }))
                                    this.set(o, true)
                                } catch (e) {
                                    this._error(`File ${file} couldn't be read as JSON. Error: ${e.message}`, e, false)
                                }                                
                            }
                        }
                        /*
                        if (eventType === 'change') {
                            log(`> File ${filename} changed ! Auto-loading...`)
                            try {
                                let o = JSON.parse(fs.readFileSync(this.file, { encoding: this.options.encoding }))
                            } catch (e) {
                                console.log(e)
                                this._error(`File ${file} couldn't be read as JSON. Error: ${e.getMessage()}`, e)
                            }
                        }
                        */
                    })
                }
                
            }
        }
        let $this = this
        this._data = data
        
        // Creating the new LiveJSONObjectProp
        this._val = new LiveJSONObjectProp(data, null, (e) => { return $this._onSet.apply($this, [e]) }, (e) => { return $this._onGet.apply($this, [e]); })
        this._created = true
    }
    /**
     * Error func, will throw error if no error event is listened
     * @param {*} message the error message to show
     * @param {*} originalError the original error (catched or not)
     */
    _error (message, originalError) {
        let e = new Error(message)
        e.originalError = originalError
        if (!this.listenerCount('error')) {
            if (!this._created) {
                this._errorsAtStart.push(e)
            }
        } else {
            this.emit('error', e, originalError)
        }
    }
    _onGet(event) {
        // Do something ?
    }
    
    /**
     * Called when a change is done on any property of the object
     */
    _onSet(event) {
        let hasChange = event.value !== event.oldValue
        if (!hasChange) {
            return false
        }
        let diffuseChange = false
        
        // Type: value, a common assignation
        if (event.type === 'value') {
            this.emit('propchange', {
                type: 'propchange',
                fullname: event.fullpath,
                name: event.name,
                oldValue: event.oldValue,
                value: event.value,
                external: false
            })
            diffuseChange = true
        } else if (event.type === 'array') { // Type array, an array was changed
            diffuseChange = true
        } else if (event.type === 'arrayvalue') { // Type arrayvalue, a value in the array changed
            diffuseChange = false
            this.emit('propchange', {
                type: 'propchange',
                fullname: event.fullpath,
                name: event.name,
                oldValue: event.oldValue,
                value:event.value,
                index: event.index,
                added: event.added,
                removed: event.removed,
                external: false
            })
        }
        if (event.value === event.oldValue) {
            diffuseChange = false
        }
        if (!diffuseChange) {
            return
        }
        
        // Emitting change only if we have a "value" or "array" event
        this.emit('change', {
            type: 'change',
            fullname: event.fullpath,
            name: event.name,
            oldValue: event.oldValue,
            value: event.value,
            external: false
        })
        // Same for saving
        if (fs && this.options.autosave) {
            if (fs.existsSync(this.file)) {
                try {
                    fs.accessSync(this.file, fs.constants.W_OK)
                }
                catch (err) {
                   return this._error(`Counldn't write to file ${this.file}: ${err}`, err)
                }
            }
            log(`> Writing changes to file ${this.file}`)
            this.writing = true
            fs.writeFile(this.file, JSON.stringify(this._data, 0, this.options.spacer), (err) => {
                if (err) {
                    return this._error(`Counldn't write to file ${this.file}: ${err}`, err)
                }
                this.lastFileStat = fs.statSync(this.file)
            })
        }
    }
    
    get() {
        return this._val
    }
    /**
     * Change all the properties of the LiveJSON object
     * @param {Object} obj the object containing the changes
     * @param {Boolean} external if the change is an external change or not
     */
    set(obj, external) {
        if (external === undefined) {
            external = false
        }
        let emitPropChangeEvent = true
        var $this = this
        function SetProp(a, b, parent) {
            // log(`>> Comparing (${parent})`, a, 'and', b)
            function SetPropAtIndex(a, b, i, parent) {
                log.$3(`>>> Comparing ${i} in ${parent}`)
                let hasChange = false
                if (typeof a[i] !== typeof b[i] || Array.isArray(a[i]) !== Array.isArray(b[i])) {
                    if (typeof b[i] === 'undefined') {
                        delete a[i]
                    } else {
                        a[i] = b[i]
                    }
                    hasChange = true
                } else {
                    if (typeof(a[i]) === 'object') {
                        hasChange = SetProp(a[i], b[i], i)
                    } else if (a[i] !== b[i]) {
                        log.$2(`>>>> Changed "${i}" ! ${a[i]} > ${b[i]}`)
                        a[i] = b[i]
                        hasChange = true
                    } else {
                        log.$3(`>>>> Equals "${i}" ! ${a[i]} = ${b[i]}`)
                    }
                }
                if (hasChange && Array.isArray(a) && Array.isArray(b)) {
                    let index = 0
                    while (index < a.length) {
                        if (typeof(a[index]) === 'undefined') {
                            a.splice(index, 1)
                        } else {
                            index++
                        }
                    }
                }
                if (hasChange && emitPropChangeEvent) {
                    let fullpath = i
                    let oldValue = a[i]
                    if (parent !== null) {
                        fullpath = parent + '.' + i
                    }
                    let baseEvent = {
                        type: 'change',
                        fullname: fullpath,
                        name: i,
                        oldValue: oldValue,
                        value: b[i],
                        external: external
                    }
                    if (Array.isArray(a)) {
                        baseEvent.index = i
                        baseEvent.added = baseEvent.removed = false
                        if (typeof b[i] === 'undefined') {
                            baseEvent.added = true
                        } else if (typeof a[i] === 'undefined') {
                            baseEvent.removed = true
                        }
                    }
                    $this.emit('propchange', baseEvent)
                }
                return hasChange
            }
            let noChanges = true
            if (Array.isArray(a) && Array.isArray(b)) {
                a.forEach((o, index) => {
                    noChanges = !SetPropAtIndex(a, b, index, parent) && noChanges
                })
                b.forEach((o, index) => {
                    if (index >= a.length) {
                        noChanges = !SetPropAtIndex(a, b, index, parent) && noChanges
                    }
                })
            } else {
                let allKeys = Object.keys(a).concat(Object.keys(b)).filter((value,index,self) => { return self.indexOf(value) === index })
                allKeys.forEach((name) => {
                    noChanges = !SetPropAtIndex(a, b, name, parent) && noChanges
                })
            }
            return !noChanges
        }
        let prevData = Object.assign({}, $this._data)
        let propsChanged = SetProp($this._data, obj, null)
        log('! No changes ?', propsChanged)
        if (propsChanged) {
            this.emit('change', {
                type: 'change',
                fullname: null,
                name: null,
                oldValue: prevData,
                value: obj,
                external: external
            })
        }
    }
    get $() {
        return this._val
    }
    
}

module.exports = LiveJSON
module.exports.VERBOSE = 0