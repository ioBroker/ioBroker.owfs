/**
 *
 *      ioBroker OWFS Adapter
 *
 *      Copyright (c) 2015-2020 bluefox<dogafox@gmail.com>
 *
 *      MIT License
 *
 */
/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';
const utils       = require('@iobroker/adapter-core'); // Get common adapter utils
const adapterName = require('./package.json').name.split('.').pop();
let OWJS    = null;
let fs      = null;

const timers  = {};
let client  = null;
const objects = {};
let path1wire;
const OW_DIRALL = 7; // list 1-wire bus, in one packet string // workaround for owserver
let alarmPollingTimer = null;
let activeAlarm = false;

let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName});
    adapter = new utils.Adapter(options);

    adapter.on('message', obj => obj && processMessage(obj));

    adapter.on('ready', () => main());

    adapter.on('unload', callback => {
        for (const t in timers) {
            clearInterval(timers[t].timer);
            timers[t].timer = null;
        }
        if (alarmPollingTimer) {
            clearInterval(alarmPollingTimer);
            alarmPollingTimer = null;
        }
        callback && callback();
    });

    adapter.on('stateChange', (id, state) => {
        if (!id || !state || state.ack) return;
        if (!adapter.config.wires) return;

        if (id === adapter.namespace + '.alarm') {
            activeAlarm = !(state.val === false || state.val === 0 || state.val === '0' || state.val === 'false');
            return;
        }
        let wire;
        for (let i = 0; i < adapter.config.wires.length; i++) {
            if (adapter.config.wires[i] && id === adapter.namespace + '.wires.' + adapter.config.wires[i]._name) {
                if (state.val === true || state.val === 'true') {
                    state.val = 1;
                } else
                if (state.val === false || state.val === 'false') {
                    state.val = 0;
                }
                wire = adapter.config.wires[i];
                break;
            }
        }
        if (wire) {
            if (state.val === null) {
                return;
            }

            if (!objects[id]) {
                adapter.getForeignObject(id, (err, obj) => {
                    objects[id] = obj;
                    if (obj && obj.common && !obj.common.write) {
                        adapter.log.debug('Cannot write read only "' + id + '"');
                    } else {
                        writeWire(wire, state.val);
                    }
                });
            } else {
                if (objects[id] && objects[id].common && !objects[id].common.write) {
                    adapter.log.debug('Cannot write read only "' + id + '"');
                } else {
                    writeWire(wire, state.val);
                }
            }
        } else {
            adapter.log.warn('Wire "' + id + '" not found');
        }
    });

    return adapter;
}

function readSensors(oClientOrPath, sensors, result, cb) {
    result = result || {};
    if (!sensors || !sensors.length) {
        return cb && cb(result);
    }
    const sensor = sensors.shift();

    if (typeof oClientOrPath === 'object') {
        oClientOrPath.list('/' + sensor, (err, dirs) => {
            result[sensor] = dirs;
            if (dirs) {
                for (let d = 0; d < dirs.length; d++) {
                    if (dirs[d].substring(0, sensor.length + 2) === '/' + sensor + '/') {
                        dirs[d] = dirs[d].substring(sensor.length + 2);
                    }
                    if (possibleSubTrees.indexOf(dirs[d]) !== -1) {
                        sensors.push(sensor + '/' + dirs[d]);
                    }
                }
            }
            setImmediate(() => readSensors(oClientOrPath, sensors, result, cb));
        });
    } else {
        fs.readdir(oClientOrPath + '/' + sensor, (err, dirs) => {
            result[sensor] = dirs;

            dirs && dirs.forEach(dir => possibleSubTrees.includes(dir) && sensors.push(sensor + '/' + dir));

            setImmediate(() => readSensors(oClientOrPath, sensors, result, cb));
        });
    }
}

const possibleSubTrees = [
    'LED',
    'relay',
    'set_alarm'
];

const ignoreDevices = [
    'alarm',
    'structure',
    'system',
    'settings',
    'uncached',
    'simultaneous',
    'statistics'
];

function processMessage(msg) {
    if (!msg || !msg.command) {
        return;
    }

    switch (msg.command) {
        case 'readdir':
            if (msg.callback) {
                let _client = null;
                if (msg.message.config && msg.message.config.ip) {
                    adapter.log.debug('Connect to ' + msg.message.config.ip + ':' + msg.message.config.port);
                    _client = getOWFSClient({host: msg.message.config.ip, port: msg.message.config.port});
                } else if (msg.message.config && !msg.message.config.path) {
                    _client = client;
                }

                if (_client) {
                    _client.list('/', (err, dirs) => {
                        if (err) {
                            adapter.log.error('Cannot read dir: ' + err);
                            adapter.sendTo(msg.from, msg.command, {error: err.toString()}, msg.callback);
                            _client = null;
                        } else {
                            adapter.log.debug('Result for list: ' + JSON.stringify(dirs));
                            for (let d = dirs.length - 1; d >= 0; d--) {
                                if (!dirs[d] || dirs[d][0] !== '/') {
                                    dirs.splice(d, 1);
                                } else {
                                    dirs[d] = dirs[d].substring(1);
                                }
                                // remove some constant entries
                                if (ignoreDevices.indexOf(dirs[d]) !== -1 || dirs[d].match(/^bus\./)) dirs.splice(d, 1);
                            }
                            adapter.log.debug('Result for list_: ' + JSON.stringify(dirs));

                            // read all sensors
                            readSensors(_client, dirs, null, result => {
                                adapter.log.debug('Result for dir: ' + JSON.stringify(result));
                                adapter.sendTo(msg.from, msg.command, {sensors: result}, msg.callback);
                                _client = null;
                            });
                        }
                    });
                } else {
                    fs = fs || require('fs');
                    let _path1wire =  msg.message.config ? msg.message.config.path || '/mnt/1wire' : '/mnt/1wire';
                    if (_path1wire[_path1wire.length - 1] === '/') {
                        _path1wire = _path1wire.substring(0, _path1wire.length - 1);
                    }
                    fs.readdir(_path1wire, (err, dirs) => {
                        if (err) {
                            adapter.log.error('Cannot read dir: ' + err);
                            adapter.sendTo(msg.from, msg.command, {error: err.toString()}, msg.callback);
                        } else {
                            for (let d = dirs.length - 1; d >= 0; d--) {
                                // remove some constant entries
                                if (!dirs[d] || ignoreDevices.indexOf(dirs[d]) !== -1 || dirs[d].match(/^bus\./)) {
                                    dirs.splice(d, 1);
                                }
                            }

                            // read all sensors
                            readSensors(_path1wire, dirs, null, result =>
                                adapter.sendTo(msg.from, msg.command, {sensors: result}, msg.callback));
                        }
                    });
                }
            }

            break;
        default:
            adapter.log.error('Messages are not supported');
            break;
    }
}

function writeWire(wire, value) {
    if (wire) {
        let property = wire.property || 'temperature';
        if (property === 'sensed.BYTE') {
            property = 'PIO.BYTE';
        }
        let val;

        if (property.indexOf('.ALL') !== -1) {
            val = value;
        } else
        if (property.indexOf('PIO') !== -1 && property.indexOf('.BYTE') === -1) {
            val = (value === '0' || value === 0 || value === 'false' || value === false) ? 0 : 1;
        } else {
            val = parseFloat(value) || 0;
        }

        adapter.log.debug('Write /' + wire.id + '/' + (wire.property || 'temperature') + ' with "' + val + '"');
        if (client) {
            client.write('/' + wire.id + '/' + property, val, (err, message) => {
                if (message !== undefined) {
                    adapter.log.debug('Response for write /' + wire.name + '/' + property + ': ' + message);
                }
                // no idea what is received here
                if (err) {
                    adapter.log.warn('Cannot write value of /' + wire.id + '/' + property + ': ' + JSON.stringify(err));
                    adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84});
                } else {
                    // ALL is like "0,1"
                    if (property.indexOf('.ALL') !== -1) {
                        adapter.setState('wires.' + wire._name, value || '', true);
                    } else
                    // PIO.0, PIO.1, PIO.A are boolean
                    if (property.indexOf('PIO') !== -1 && property.indexOf('.BYTE') === -1) {
                        adapter.setState('wires.' + wire._name, !(value === '0' || value === 0 || value === 'false' || value === false), true);
                    } else {
                        // alse some float value, e.g. temperature
                        adapter.setState('wires.' + wire._name, parseFloat(value) || 0, true);
                    }
                }
            });
        } else {
            const pathFile = path1wire + '/' + wire.id + '/' + property;

            adapter.log.debug(pathFile + ' with "' + val + '"');
            // Write to file
            fs.writeFile(pathFile, val, (err/*, written*/) => {
                if (err) {
                    // Write error
                    adapter.log.warn('Cannot write value of ' + pathFile + ': ' + JSON.stringify(err));
                    adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84});
                } else {
                    // ALL is like "0,1"
                    if (property.indexOf('.ALL') !== -1) {
                        adapter.setState('wires.' + wire._name, value || '', true);
                    } else
                    // PIO.0, PIO.1, PIO.A are boolean
                    if (property.indexOf('PIO') !== -1 && property.indexOf('.BYTE') === -1) {
                        adapter.setState('wires.' + wire._name, !(value === '0' || value === 0 || value === 'false' || value === false), true);
                    } else {
                        // alse some float value, e.g. temperature
                        adapter.setState('wires.' + wire._name, parseFloat(value) || 0, true);
                    }
                }
            });
        }
    }
}

function getOWFSClient(settings) {
    OWJS = OWJS || require('owjs');
    client = new OWJS.Client(settings);

    client.list = function (path, callback) {
        this.send(path, null, OW_DIRALL).then(messages => {
            let ret;
            let str;
            for (let m = 0; m < messages.length; m++) {
                ret = messages[m].header ? messages[m].header.ret : -100;
                if (messages[m].header && messages[m].header.payload > 0 && messages[m].header.ret >= 0) {
                    str = messages[m].payload;
                    break;
                }
            }
            if (ret < 0) {
                adapter.log.warn('Invalid response for list: ' + ret);
                callback('Invalid response');
                return;
            }
            if (!str) {
                adapter.log.warn('Invalid response for list [empty answer]: ' + JSON.stringify(messages));
                callback('Invalid response for list [empty answer]');
                return;
            }
            str = str.substring(0, str.length - 1); // remove zero-char from end
            callback(null, str.split(','));
        }, error => callback(error));
    };
    return client;
}

function owfsParseFloat(s) {
    let val = parseFloat(s);
    if (!isNaN(val)) {
        return val;
    }
    return parseFloat(s.replace(/^[\s\uFEFF\xA0\x00\x0C]+|[\s\uFEFF\xA0\x00\x0C]+$/g, ''));
}

function readWire(wire) {
    if (wire.iButton && !wire.property) wire.property = 'r_address';
    if (wire) {
        if (client) {
            adapter.log.debug('Reading ' + '/' + wire.id + '/' + (wire.property || 'temperature'));
            client.read('/' + wire.id + '/' + (wire.property || 'temperature'), (err, result) => {
                if (result) {
                    result.value = result.value || '0';
                    result.value = result.value.trim();
                    adapter.log.debug('Read result ' + result.path + ':' + result.value);
                }

                if (!err && result) {
                    if (wire.iButton) {
                        adapter.setState('wires.' + wire._name, {val: true, ack: true, q: 0}); // sensor reports OK
                    } else {
                        // ALL is like "0,1"
                        if (wire.property.indexOf('.ALL') !== -1) {
                            adapter.setState('wires.' + wire._name, {val: result.value || '', ack: true, q: 0});
                        } else
                        // PIO.0, PIO.1, PIO.A are boolean
                        if (wire.property.indexOf('PIO') !== -1 && wire.property.indexOf('.BYTE') === -1) {
                            adapter.setState('wires.' + wire._name, {val: result.value === '1' || result.value === 1, ack: true, q: 0});
                        } else {
                            // else some float value, e.g. temperature
                            let val = owfsParseFloat(result.value);
                            if (!isNaN(val)) {
                                if (adapter.config.noStateChangeOn85C && val >= 84.999 && val <= 85.001) {
                                    adapter.log.info('Ignoring 85.0°C value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + result.value);
                                } else {
                                    adapter.setState('wires.' + wire._name, {val: val, ack: true, q: 0});
                                }
                            } else {
                                adapter.log.info('Cannot parse value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + result.value);
                                if (!adapter.config.noStateChangeOnError) {
                                    adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x42}); // sensor reports nonsense
                                }
                            }
                        }
                    }
                } else {
                    if (wire.iButton) {
                        adapter.setState('wires.' + wire._name, {val: false, ack: true, q: 0}); // sensor reports error
                    } else {
                        if (!adapter.config.noStateChangeOnError) {
                        adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                        }
                        adapter.log.info('Cannot read value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
                    }
                }
            });
        } else {
            const pathFile = path1wire + '/' + wire.id + '/' + (wire.property || 'temperature');
            // Read from file
            adapter.log.debug('Reading ' + pathFile);
            try {
                const result = fs.readFileSync(pathFile, 'utf8').toString();
                adapter.log.debug('Read result ' + pathFile + ': ' + result);

                if (wire.iButton) {
                    adapter.setState('wires.' + wire._name, {val: true, ack: true, q: 0}); // sensor reports OK
                } else {
                    // ALL is like "0,1"
                    if (wire.property.indexOf('.ALL') !== -1) {
                        adapter.setState('wires.' + wire._name, {val: result || '', ack: true, q: 0});
                    } else
                    // PIO.0, PIO.1, PIO.A are boolean
                    if (wire.property.indexOf('PIO') !== -1 && wire.property.indexOf('.BYTE') === -1) {
                        adapter.setState('wires.' + wire._name, {val: result === '1', ack: true, q: 0});
                    } else {
                        // else some float value, e.g. temperature
                        let val = owfsParseFloat(result);
                        if (!isNaN(val)) {
                            if (adapter.config.noStateChangeOn85C && val >= 84.999 && val <= 85.001) {
                                    adapter.log.info('Ignoring 85.0°C value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + result.value);
                                } else {
                                    adapter.setState('wires.' + wire._name, {val: val, ack: true, q: 0});
                                }
                        } else {
                            adapter.log.info('Cannot parse value of ' + pathFile + ': ' + result);
                            if (!adapter.config.noStateChangeOnError) {
                                adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x42}); // sensor reports nonsense
                            }
                        }
                    }
                }
            } catch (err) {
                if (wire.iButton) {
                    adapter.setState('wires.' + wire._name, {val: false, ack: true, q: 0}); // sensor reports error
                } else {
                    if (!adapter.config.noStateChangeOnError) {
                        adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                    }
                    adapter.log.info('Cannot read value of ' + pathFile + ': ' + err);
                }
            }
        }
    }
}

function pollAll(intervalMs) {
    if (!adapter.config.wires) return;

    if (!intervalMs) {
        for (let i = 0; i < adapter.config.wires.length; i++) {
            adapter.config.wires[i] && readWire(adapter.config.wires[i]);
        }
    } else if (timers[intervalMs]) {
        const intPorts = timers[intervalMs].ports;
        for (let j = 0; j < intPorts.length; j++) {
            readWire(adapter.config.wires[intPorts[j]]);
        }
    } else {
        adapter.log.error('Strange: interval started, but no one ports found for that');
    }

}

function pollAlarm() {
    // ignore polling if pending alarm
    if (activeAlarm) {
        return;
    }

    fs = fs || require('fs');
    fs.readdir(path1wire + '/alarm', (err, dirs) => {
        if (err || !dirs.length) {
            return;
        }

        activeAlarm = true;
        adapter.setState(adapter.namespace + '.alarm', true);
        dirs.forEach(dir => {
            adapter.log.info('Alarm on ' + dir);
            adapter.config.wires.forEach(wire =>
                wire && wire.id === dir && readWire(wire));
        });
    });
}

function createState(wire, callback) {
    const obj = {
        name:       (wire.name || wire.id),
        type:       'number',
        read:       true,
        write:      true,
        role:       'value.' + (wire.property || 'temperature'),
        desc:       '1wire sensor'
    };
    if (wire.iButton) {
        obj.type  = 'boolean';
        obj.write = false;
        obj.role  = 'indicator';
        obj.desc  = '1wire iButton'
    } else {
        if (obj.role === 'value.temperature') {
            obj.role    = 'level.temperature';
            obj.unit    = '°C';
            obj.write   = false;
        }

        if (obj.role === 'value.humidity') {
            obj.role    = 'level.humidity';
            obj.unit    = '%';
            obj.min     = 0;
            obj.max     = 100;
            obj.write   = false;
        }

        if (wire.property.indexOf('PIO') !== -1) {
            obj.type = 'boolean';
            obj.role = 'switch';
        }
    }

    adapter.createState('', 'wires', wire._name, obj, {
        id:         wire.id,
        property:   wire.property
    }, callback);
}

function addState(wire, callback) {
    adapter.getObject('wires', (err, obj) => {
        if (err || !obj) {
            // if root does not exist, channel will not be created
            adapter.createChannel('', 'wires', [], () => createState(wire, callback));
        } else {
            createState(wire, callback);
        }
    });
}

function syncConfig(cb) {
    adapter.getStatesOf('', 'wires', (err, _states) => {
        const configToDelete = [];
        const configToAdd    = [];
        let k;
        let count = 0;
        if (adapter.config.wires) {
            for (k = 0; k < adapter.config.wires.length; k++) {
                if (!adapter.config.wires[k] || (!adapter.config.wires[k].name && !adapter.config.wires[k].id)) {
                    adapter.log.error('Invalid config for wire with index ' + k);
                    continue;
                }

                adapter.config.wires[k]._name = (adapter.config.wires[k].name || adapter.config.wires[k].id).replace(/[.\s\/]+/g, '_');
                configToAdd.push(adapter.namespace + '.wires.' + adapter.config.wires[k]._name);
            }
        }

        if (_states) {
            for (let j = 0; j < _states.length; j++) {
                const pos = configToAdd.indexOf(_states[j]._id);
                // Entry still exists
                if (pos !== -1) {
                    configToAdd.splice(pos, 1);

                    if (adapter.config.wires) {
                        // Check room, id and property
                        for (let u = 0; u < adapter.config.wires.length; u++) {
                            if (!adapter.config.wires[u] || !adapter.config.wires[u]._name) continue;

                            if (adapter.namespace + '.wires.' + adapter.config.wires[u]._name === _states[j]._id) {
                                if (_states[j].common.name     !== (adapter.config.wires[u].name || adapter.config.wires[u].id) ||
                                    _states[j].native.id       !== adapter.config.wires[u].id ||
                                    _states[j].native.property !== adapter.config.wires[u].property) {
                                    adapter.extendObject(_states[j]._id, {
                                        common: {
                                            name: (adapter.config.wires[u].name || adapter.config.wires[u].id)
                                        },
                                        native: {
                                            id:         adapter.config.wires[u].id,
                                            property:   adapter.config.wires[u].property
                                        }
                                    });
                                }
                            }
                        }
                    }
                } else {
                    configToDelete.push(_states[j]._id);
                }
            }
        }

        if (configToAdd.length && adapter.config.wires) {
            for (let r = 0; r < adapter.config.wires.length; r++) {
                if (!adapter.config.wires[r] || !adapter.config.wires[r]._name) continue;
                if (configToAdd.indexOf(adapter.namespace + '.wires.' + adapter.config.wires[r]._name) !== -1) {
                    count++;
                    addState(adapter.config.wires[r], () =>
                        !--count && cb && cb());
                }
            }
        }
        if (configToDelete.length) {
            for (let e = 0; e < configToDelete.length; e++) {
                count++;
                adapter.deleteState('', 'wires', configToDelete[e], () =>
                    !--count && cb && cb());
            }
        }

        if (!count && cb) cb();
    });
}

function main() {
    if (adapter.config.interval < 1) {
        adapter.config.interval = 1;
    }

    if (!adapter.config.local) {
        client = getOWFSClient({host: adapter.config.ip, port: adapter.config.port});
    } else {
        fs = require('fs');
        path1wire = adapter.config.path || '/mnt/1wire';
        if (path1wire[path1wire.length - 1] === '/') {
            path1wire = path1wire.substring(0, path1wire.length - 1);
        }
    }

    syncConfig();

    if (!adapter.config.wires) {
        return;
    }

    pollAll();
    for (let i = 0; i < adapter.config.wires.length; i++) {
        if (!adapter.config.wires[i]) continue;
        if (!adapter.config.wires[i].interval) {
            adapter.config.wires[i].interval = adapter.config.interval * 1000;
        } else {
            adapter.config.wires[i].interval *= 1000;
            if (!adapter.config.wires[i].interval) adapter.config.wires[i].interval = adapter.config.interval * 1000;
        }
        // If interval yet exists, just add to list
        if (timers[adapter.config.wires[i].interval]) {
            timers[adapter.config.wires[i].interval].ports.push(i);
            continue;
        }
        // start new interval
        timers[adapter.config.wires[i].interval] = {
            timer: setInterval(pollAll, adapter.config.wires[i].interval, adapter.config.wires[i].interval),
            ports: [i]
        };
    }

    if (alarmPollingTimer) {
        clearInterval(alarmPollingTimer);
        alarmPollingTimer = null;
    }

    adapter.config.alarmInterval = parseInt(adapter.config.alarmInterval, 10);

    if (adapter.config.alarmInterval) {
        activeAlarm = false;
        adapter.getObject('states.alarm', (err, obj) => {
            !obj && adapter.createState('', 'states', 'alarm', false, {
              read:  true,
              write: false,
              desc:  '1wire alarm indication',
              type:  'boolean',
              def:   false,
              role:  'state'
            });
        });
        alarmPollingTimer = setInterval(pollAlarm, adapter.config.alarmInterval);
    }

    adapter.subscribeStates('*');
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
