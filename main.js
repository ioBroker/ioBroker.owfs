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
var utils   = require(__dirname + '/lib/utils'); // Get common adapter utils
var adapter = utils.adapter('owfs');
var OWJS    = null;
var fs      = null;

var timer   = null;
var client  = null;
var objects = {};
var path1wire;

adapter.on('message', function (obj) {
    if (obj) processMessage(obj);
    processMessages();
});

adapter.on('ready', function () {
    main();
});

adapter.on('unload', function () {
    if (timer) {
        clearInterval(timer);
        timer = 0;
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


function processMessage(msg) {
    if (!msg || !msg.command) return;

    switch (msg.command) {
        case 'readdir':
            if (msg.callback) {
                var _client = null;
                if (msg.message.config && msg.message.config.ip) {
                    adapter.log.debug('Connect to ' + msg.message.config.ip + ':' + msg.message.config.port);
                    _client = new OWJS.Client({host: msg.message.config.ip, port: msg.message.config.port});
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
                    var _path1wire =  msg.message.config ? msg.message.config.path || '/mnt/1wire' : '/mnt/1wire';
                    if (_path1wire[_path1wire.length - 1] === '/') _path1wire = _path1wire.substring(0, _path1wire.length - 1);
                    fs.readdir(_path1wire, function (err, dirs) {
                        if (err) {
                            adapter.log.error('Cannot read dir: ' + err);
                            adapter.sendTo(msg.from, msg.command, {error: err.toString()}, msg.callback);
                        } else {
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

function readWire(wire) {
    if (wire) {
        if (client) {
            client.read('/' + wire.id + '/' + (wire.property || 'temperature'), function(err, result) {
                result.value = result.value || '0';
                result.value = result.value.trim();
                adapter.log.debug('Read ' + result.path + ':' + result.value);

                if (!err) {
                    // ALL is like "0,1"
                    if (wire.property.indexOf('.ALL') !== -1) {
                        adapter.setState('wires.' + wire._name, result.value || '', true);
                    } else
                    // PIO.0, PIO.1, PIO.A are boolean    
                    if (wire.property.indexOf('PIO') !== -1 && wire.property.indexOf('.BYTE') === -1) {
                        adapter.setState('wires.' + wire._name, (result.value == '1'), true);
                    } else {
                        // alse some float value, e.g. temperature
                        adapter.setState('wires.' + wire._name, parseFloat(result.value) || 0, true);
                    }
                } else {
                    adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                    adapter.log.warn('Cannot read value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
                }
            });
        } else {
            var pathfile = path1wire + '/' + wire.id + '/' + (wire.property || 'temperature');
            // Read from file
            fs.readFile(pathfile, function (err, result) {
                if (!err) {
                    result = result.toString();
                    adapter.log.debug('Read ' + pathfile + ': ' + result);

                    // ALL is like "0,1"
                    if (wire.property.indexOf('.ALL') !== -1) {
                        adapter.setState('wires.' + wire._name, result || '', true);
                    } else
                    // PIO.0, PIO.1, PIO.A are boolean    
                    if (wire.property.indexOf('PIO') !== -1 && wire.property.indexOf('.BYTE') === -1) {
                        adapter.setState('wires.' + wire._name, (result == '1'), true);
                    } else {
                        // alse some float value, e.g. temperature
                        adapter.setState('wires.' + wire._name, parseFloat(result) || 0, true);
                    }
                } else {
                    adapter.setState('wires.' + wire._name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                    adapter.log.warn('Cannot read value of ' + pathfile + ': ' + err);
                }
            });
        }
    }
}

function pollAll() {
    if (!adapter.config.wires) return;
    for (var i = 0; i < adapter.config.wires.length; i++) {
        if (adapter.config.wires[i]) readWire(adapter.config.wires[i]);
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
        OWJS = require('owjs');
        client = new OWJS.Client({host: adapter.config.ip, port: adapter.config.port});
    } else {
        fs = require('fs');
        path1wire = adapter.config.path || '/mnt/1wire';
        if (path1wire[path1wire.length - 1] === '/') path1wire = path1wire.substring(0, path1wire.length - 1);
    }

    syncConfig();

    pollAll();
    timer = setInterval(pollAll, adapter.config.interval * 1000);
    adapter.subscribeStates('*');
}

