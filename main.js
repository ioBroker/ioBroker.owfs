/**
 *
 *      ioBroker OWFS Adapter
 *
 *      Copyright (c) 2015-2016 bluefox<dogafox@gmail.com>
 *
 *      MIT License
 *
 */
/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';
var utils = require('@iobroker/adapter-core'); // Get common adapter utils
var adapter = utils.Adapter('owfs');
var OWJS    = null;
var fs      = null;

var timers  = {};
var client  = null;
var objects = {};
var path1wire;
var OW_DIRALL = 7; // list 1-wire bus, in one packet string // workaround for owserver

adapter.on('message', function (obj) {
    if (obj) processMessage(obj);
    processMessages();
});

adapter.on('ready', function () {
    main();
});

adapter.on('unload', function () {
    for (var t in timers) {
        clearInterval(timers[t].timer);
        timers[t].timer = null;
    }
});

adapter.on('stateChange', function (id, state) {
    if (!id || !state || state.ack) return;
    if (!adapter.config.wires) return;

    var wire;
    for (var i = 0; i < adapter.config.wires.length; i++) {
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
        if (state.val === null) return;
        if (!objects[id]) {
            adapter.getForeignObject(id, function (err, obj) {
                objects[id] = obj;
                if (obj && obj.common && !obj.common.write) {
                    adapter.log.debug('Cannot write read only "' + id + '"');
                    return;
                }
                writeWire(wire, state.val);
            });
        } else {
            if (objects[id] && objects[id].common && !objects[id].common.write) {
                adapter.log.debug('Cannot write read only "' + id + '"');
                return;
            }
            writeWire(wire, state.val);
        }
    } else {
        adapter.log.warn('Wire "' + id + '" not found');
    }
});

function readSensors(oClientOrPath, sensors, result, cb) {
    result = result || {};
    if (!sensors || !sensors.length) {
        return cb && cb(result);
    }
    var sensor = sensors.shift();

    if (typeof oClientOrPath === 'object') {
        oClientOrPath.list('/' + sensor, function(err, dirs) {
            result[sensor] = dirs;
            if (dirs) {
                for (var d = 0; d < dirs.length; d++) {
                    if (dirs[d].substring(0, sensor.length + 2) === '/' + sensor + '/') {
                        dirs[d] = dirs[d].substring(sensor.length + 2);
                    }
                    if (possibleSubTrees.indexOf(dirs[d]) !== -1) {
                        sensors.push(sensor + '/' + dirs[d]);
                    }
                }
            }
            setTimeout(function () {
                readSensors(oClientOrPath, sensors, result, cb);
            }, 0);
        });
    } else {
        fs.readdir(oClientOrPath + '/' + sensor, function (err, dirs) {
            result[sensor] = dirs;
            if (dirs) {
                for (var d = 0; d < dirs.length; d++) {
                    if (possibleSubTrees.indexOf(dirs[d]) !== -1) {
                        sensors.push(sensor + '/' + dirs[d]);
                    }
                }
            }
            setTimeout(function () {
                readSensors(oClientOrPath, sensors, result, cb);
            }, 0);
        });
    }
}

var possibleSubTrees = [
    'LED',
    'relay',
    'set_alarm'
];

var ignoreDevices = [
    'alarm',
    'structure',
    'system',
    'settings',
    'uncached',
    'simultaneous',
    'statistics'
];

function processMessage(msg) {
    if (!msg || !msg.command) return;

    switch (msg.command) {
        case 'readdir':
            if (msg.callback) {
                var _client = null;
                if (msg.message.config && msg.message.config.ip) {
                    adapter.log.debug('Connect to ' + msg.message.config.ip + ':' + msg.message.config.port);
                    _client = getOWFSClient({host: msg.message.config.ip, port: msg.message.config.port});
                } else if (msg.message.config && !msg.message.config.path) {
                    _client = client;
                }

                if (_client) {
                    _client.list('/', function(err, dirs) {
                        if (err) {
                            adapter.log.error('Cannot read dir: ' + err);
                            adapter.sendTo(msg.from, msg.command, {error: err.toString()}, msg.callback);
                            _client = null;
                        } else {
                            adapter.log.debug('Result for list: ' + JSON.stringify(dirs));
                            for (var d = dirs.length - 1; d >= 0; d--) {
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
                            readSensors(_client, dirs, null, function (result) {
                                adapter.log.debug('Result for dir: ' + JSON.stringify(result));
                                adapter.sendTo(msg.from, msg.command, {sensors: result}, msg.callback);
                                _client = null;
                            });
                        }
                    });
                } else {
					fs = fs || require('fs');
                    var _path1wire =  msg.message.config ? msg.message.config.path || '/mnt/1wire' : '/mnt/1wire';
                    if (_path1wire[_path1wire.length - 1] === '/') _path1wire = _path1wire.substring(0, _path1wire.length - 1);
                    fs.readdir(_path1wire, function (err, dirs) {
                        if (err) {
                            adapter.log.error('Cannot read dir: ' + err);
                            adapter.sendTo(msg.from, msg.command, {error: err.toString()}, msg.callback);
                        } else {
							for (var d = dirs.length - 1; d >= 0; d--) {
                                // remove some constant entries
                                if (!dirs[d] || ignoreDevices.indexOf(dirs[d]) !== -1 || dirs[d].match(/^bus\./)) {
                                    dirs.splice(d, 1);
                                }
                            }

                            // read all sensors
                            readSensors(_path1wire, dirs, null, function (result) {
                                adapter.sendTo(msg.from, msg.command, {sensors: result}, msg.callback);
                            });
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

function processMessages() {
    adapter.getMessage(function (err, obj) {
        if (obj) {
            processMessage(obj.command, obj.message);
            processMessages();
        }
    });
}

function writeWire(wire, value) {
    if (wire) {
        var property = (wire.property || 'temperature');
        if (property === 'sensed.BYTE') property = 'PIO.BYTE';
        var val;

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
            client.write('/' + wire.id + '/' + property, val, function (err, message) {
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
            var pathFile = path1wire + '/' + wire.id + '/' + property;
            
            adapter.log.debug(pathFile + ' with "' + val + '"');
            // Write to file
            fs.writeFile(pathFile, val, function (err/*, written*/) {
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
        this.send(path, null, OW_DIRALL).then(function (messages) {
            var ret;
            var str;
            for (var m = 0; m < messages.length; m++) {
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
        }, function (error) {
            callback(error);
        });
    };
    return client;
}

function readWire(wire) {
    if (wire.iButton && !wire.property) wire.property = 'r_address';
    if (wire) {
        if (client) {
            adapter.log.debug('Read ' + '/' + wire.id + '/' + (wire.property || 'temperature'));
            client.read('/' + wire.id + '/' + (wire.property || 'temperature'), function(err, result) {
                if (result) {
                    result.value = result.value || '0';
                    result.value = result.value.trim();
                    adapter.log.debug('Read ' + result.path + ':' + result.value);
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
                            adapter.setState('wires.' + wire._name, {val: (result.value == '1'), ack: true, q: 0});
                        } else {
                            // alse some float value, e.g. temperature
                            adapter.setState('wires.' + wire._name, {val: parseFloat(result.value) || 0, ack: true, q: 0});
                        }
                    }
                } else {
                    if (wire.iButton) {
                        adapter.setState('wires.' + wire._name, {val: false, ack: true, q: 0}); // sensor reports error
                    } else {
                        if (!adapter.config.noStateChangeOnError) {
                            adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                        }
                        adapter.log.warn('Cannot read value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
                    }
                }
            });
        } else {
            var pathfile = path1wire + '/' + wire.id + '/' + (wire.property || 'temperature');
            // Read from file
            adapter.log.debug('Read ' + pathfile);
            fs.readFile(pathfile, function (err, result) {
                if (!err && result) {
                    result = result.toString();
                    adapter.log.debug('Read ' + pathfile + ': ' + result);

                    if (wire.iButton) {
                        adapter.setState('wires.' + wire._name, {val: true, ack: true, q: 0}); // sensor reports OK
                    } else {
                        // ALL is like "0,1"
                        if (wire.property.indexOf('.ALL') !== -1) {
                            adapter.setState('wires.' + wire._name, {val: result || '', ack: true, q: 0});
                        } else
                        // PIO.0, PIO.1, PIO.A are boolean
                        if (wire.property.indexOf('PIO') !== -1 && wire.property.indexOf('.BYTE') === -1) {
                            adapter.setState('wires.' + wire._name, {val: (result == '1'), ack: true, q: 0});
                        } else {
                            // alse some float value, e.g. temperature
                            adapter.setState('wires.' + wire._name, {val: parseFloat(result) || 0, ack: true, q: 0});
                        }
                    }
                } else {
                    if (wire.iButton) {
                        adapter.setState('wires.' + wire._name, {val: false, ack: true, q: 0}); // sensor reports error
                    } else {
                        if (!adapter.config.noStateChangeOnError) {
                            adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                        }
                        adapter.log.warn('Cannot read value of ' + pathfile + ': ' + err);
                    }
                }
            });
        }
    }
}

function pollAll(intervalMs) {
    if (!adapter.config.wires) return;

    if (!intervalMs) {
        for (var i = 0; i < adapter.config.wires.length; i++) {
            if (adapter.config.wires[i]) readWire(adapter.config.wires[i]);
        }
    } else if (timers[intervalMs]) {
        var intPorts = timers[intervalMs].ports;
        for (var j = 0; j < intPorts.length; j++) {
            readWire(adapter.config.wires[intPorts[j]]);
        }
    } else {
        adapter.log.error('Strange: interval started, but no one ports found for that');
    }

}

function createState(wire, callback) {
    var obj = {
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
    adapter.getObject('wires', function (err, obj) {
        if (err || !obj) {
            // if root does not exist, channel will not be created
            adapter.createChannel('', 'wires', [], function () {
                createState(wire, callback);
            });
        } else {
            createState(wire, callback);
        }
    });
}

function syncConfig(cb) {
    adapter.getStatesOf('', 'wires', function (err, _states) {
        var configToDelete = [];
        var configToAdd    = [];
        var k;
        var count = 0;
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
            for (var j = 0; j < _states.length; j++) {
                var pos = configToAdd.indexOf(_states[j]._id);
                // Entry still exists
                if (pos !== -1) {
                    configToAdd.splice(pos, 1);

                    if (adapter.config.wires) {
                        // Check room, id and property
                        for (var u = 0; u < adapter.config.wires.length; u++) {
                            if (!adapter.config.wires[u] || !adapter.config.wires[u]._name) continue;

                            if (adapter.namespace + '.wires.' + adapter.config.wires[u]._name === _states[j]._id) {
                                if (_states[j].common.name != (adapter.config.wires[u].name || adapter.config.wires[u].id) ||
                                    _states[j].native.id != adapter.config.wires[u].id ||
                                    _states[j].native.property != adapter.config.wires[u].property) {
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
            for (var r = 0; r < adapter.config.wires.length; r++) {
                if (!adapter.config.wires[r] || !adapter.config.wires[r]._name) continue;
                if (configToAdd.indexOf(adapter.namespace + '.wires.' + adapter.config.wires[r]._name) != -1) {
                    count++;
                    addState(adapter.config.wires[r], function () {
                        if (!--count && cb) cb();
                    });
                }
            }
        }
        if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {
                count++
                adapter.deleteState('', 'wires', configToDelete[e], function () {
                    if (!--count && cb) cb();
                });
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
        if (path1wire[path1wire.length - 1] === '/') path1wire = path1wire.substring(0, path1wire.length - 1);
    }

    syncConfig();
    if (!adapter.config.wires) return;

    pollAll();
    for (var i = 0; i < adapter.config.wires.length; i++) {
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

    adapter.subscribeStates('*');
}

