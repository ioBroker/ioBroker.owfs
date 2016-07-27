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
var OWJS    = require('owjs');

var timer   = null;
var client  = null;

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
    for (var i = 0; i < adapter.config.wires.length; i++) {
        if (adapter.config.wires[i] && id === adapter.namespace + '.wires.' + adapter.config.wires[i]._name) {
            if (state.val === true || state.val === 'true') {
                state.val = 1;
            } else
            if (state.val === false || state.val === 'false') {
                state.val = 0;
            }

            writeWire(adapter.config.wires[i], state.val);
            break;
        }
    }
});

function readSensors(oClient, sensors, result, cb) {
    result = result || {};
    if (!sensors || !sensors.length) {
        return cb && cb(result);
    }
    var sensor = sensors.shift();

    oClient.list('/' + sensor, function(err, dirs) {
        result[sensor] = dirs;
        if (dirs) {
            for (var d = 0; d < dirs.length; d++) {
                dirs[d] = dirs[d].substring(sensor.length + 2);
            }
        }
        setTimeout(function () {
            readSensors(oClient, sensors, result, cb);
        }, 0);
    });
}

function processMessage(msg) {
    if (!msg || !msg.command) return;

    switch (msg.command) {
        case 'readir':
            if (msg.callback) {
                var _client;
                if (msg.message.config && msg.message.config.ip) {
                    _client = new OWJS.Client({host: msg.message.config.ip, port: msg.message.config.port});
                } else {
                    _client = client;
                }

                _client.list('/', function(err, dirs) {
                    if (err) {
                        adapter.log.error('Cannot read dir: ' + err)
                        adapter.sendTo(msg.from, msg.command, {error: err.toString()}, msg.callback);
                        _client = null;
                    } else {
                        for (var d = dirs.length - 1; d >= 0; d--) {
                            if (!dirs[d] || dirs[d][0] !== '/') {
                                dirs.splice(d, 1);
                            } else {
                                dirs[d] = dirs[d].substring(1);
                            }
                        }

                        // read all sensors
                        readSensors(_client, dirs, null, function (result) {
                            adapter.sendTo(msg.from, msg.command, {sensors: result}, msg.callback);
                            _client = null;
                        });
                    }
                });
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
        adapter.log.debug('Write /' + wire.id + '/' + (wire.property || 'temperature') + ' with "' + value + '"');
        client.write('/' + wire.id + '/' + (wire.property || 'temperature'), value, function (err, message) {
            if (message !== undefined) {
                adapter.log.debug('Write /' + wire.name + '/' + (wire.property || 'temperature') + ':' + message);
            }
            // no idea what is received here
            if (err) {
                adapter.log.warn('Cannot write value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
                adapter.setState('wires.' + wire.name, {val: 0, ack: true, q: 0x84});
            } else {
                if (wire.property.indexOf('PIO') === -1) {
                    adapter.setState('wires.' + wire.name, parseFloat(value) || 0, true);
                } else {
                    adapter.setState('wires.' + wire.name, !(value === '0' || value === 0 || value === 'false' || value === false), true);
                }
            }
        });
    }
}

function readWire(wire) {
    if (wire) {
        client.read('/' + wire.id + '/' + (wire.property || 'temperature'), function(err, result) {
            result.value = result.value || '0';
            result.value = result.value.trim();
            adapter.log.debug('Read ' + result.path + ':' + result.value);

            if (!err) {
                if (wire.property.indexOf('PIO') !== -1) {
                    adapter.setState('wires.' + wire.name, (result.value == '1'), true);
                } else {
                    adapter.setState('wires.' + wire.name, parseFloat(result.value) || 0, true);
                }
            } else {
                adapter.setState('wires.' + wire.name, {val: 0, ack: true, q: 0x84}); // sensor reports error
                adapter.log.warn('Cannot read value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
            }
        });
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
        def:        0,
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
        obj.def  = false;
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

function syncConfig() {
    adapter.getStatesOf('', 'wires', function (err, _states) {
        var configToDelete = [];
        var configToAdd    = [];
        var k;
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
                                            id: adapter.config.wires[u].id,
                                            property: adapter.config.wires[u].property
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
                    addState(adapter.config.wires[r]);
                }
            }
        }
        if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {
                adapter.deleteState('', 'wires', configToDelete[e]);
            }
        }
    });
}

function main() {
    if (adapter.config.interval < 1) {
        adapter.config.interval = 1;
    }

    client = new OWJS.Client({host: adapter.config.ip, port: adapter.config.port});

    syncConfig();

    pollAll();
    timer = setInterval(pollAll, adapter.config.interval * 1000);
    adapter.subscribeStates('*');
}

