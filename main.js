/**
 *
 *      ioBroker OWFS Adapter
 *
 *      Copyright (c) 2015 bluefox<dogafox@gmail.com>
 *
 *      MIT License
 *
 */
/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";
var utils =   require(__dirname + '/lib/utils'); // Get common adapter utils
var adapter = utils.adapter('owfs');
var OWFS =    require('owfs').Client;

var timer =   null;
var client =  null;

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
    for (var i = 0; i < adapter.config.wires.length; i++) {
        if (id == adapter.namespace + '.wires.' + adapter.config.wires[i]._name) {
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

function processMessage(obj) {
    if (!obj || !obj.command) return;
    switch (obj.command) {
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
        client.write('/' + wire.id + '/' + (wire.property || 'temperature'), value, function(err, message) {
            adapter.log.debug('Write /' + wire.id + '/' + (wire.property || 'temperature') + ':' + message);
            //no idea what is received here
            if (err) {
                adapter.log.warn('Cannot write value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
            }
        });
    }
}

function readWire(wire) {
    if (wire) {
        client.read('/' + wire.id + '/' + (wire.property || 'temperature'), function(err, result) {
            adapter.log.debug('Read /' + wire.id + '/' + (wire.property || 'temperature') + ':' + result);
            if (!err) {
                adapter.setState('wires.' + wire._name, result, true);
            } else {
                adapter.log.warn('Cannot read value of /' + wire.id + '/' + (wire.property || 'temperature') + ': ' + err);
            }
        });
    }
}

function pollAll() {
    for (var i = 0; i < adapter.config.wires.length; i++) {
        readWire(adapter.config.wires[i]);
    }
}

function createState(wire, callback) {
    if (wire.room) adapter.addStateToEnum('room', wire.room, '', 'wires', wire._name);

    adapter.createState('', 'wires', wire._name, {
        name:   (wire.name || wire.id),
        def:    false,
        type:   'number',
        read:   'true',
        write:  'true',
        role:   'value.' + (wire.property || 'temperature'),
        desc:   '1wire sensor'
    }, {
        id: wire.id,
        property: wire.property
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
                adapter.config.wires[k]._name = (adapter.config.wires[k].name || adapter.config.wires[k].id).replace(/[.\s\/]+/g, '_');
                configToAdd.push(adapter.namespace + '.wires.' + adapter.config.wires[k]._name);
            }
        }

        if (_states) {
            for (var j = 0; j < _states.length; j++) {
                var pos = configToAdd.indexOf(_states[j]._id);
                // Entry still exists
                if (pos != -1) {
                    configToAdd.splice(pos, 1);

                    // Check room, id and property
                    for (var u = 0; u < adapter.config.wires.length; u++) {
                        if (adapter.namespace + '.wires.' + adapter.config.wires[u]._name == _states[j]._id) {
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

                            if (adapter.config.wires[u].room) {
                                adapter.addStateToEnum('room', adapter.config.wires[u].room, '', 'wires', _states[j]._id);
                            } else {
                                adapter.deleteStateFromEnum('room', '', 'wires', _states[j]._id);
                            }
                        }
                    }
                } else {
                    configToDelete.push(_states[j]._id);
                }
            }
        }

        if (configToAdd.length) {
            for (var r = 0; r < adapter.config.wires.length; r++) {
                if (configToAdd.indexOf(adapter.namespace + '.wires.' + adapter.config.wires[r]._name) != -1) {
                    addState(adapter.config.wires[r]);
                }
            }
        }
        if (configToDelete.length) {
            for (var e = 0; e < configToDelete.length; e++) {
                adapter.deleteStateFromEnum('room', '', 'wires', configToDelete[e]);
                adapter.deleteState('', 'wires', configToDelete[e]);
            }
        }
    });
}

function main() {
    if (adapter.config.interval < 1) {
        adapter.config.interval = 1;
    }

    client = new OWFS(adapter.config.ip, adapter.config.port);

    syncConfig();

    pollAll();
    timer = setInterval(pollAll, adapter.config.interval * 1000);
    adapter.subscribeStates('*');
}

