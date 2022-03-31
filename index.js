"use strict";
/*
 * Copyright 2022 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

const POLL_INTERVAL = 60            // Poll every N seconds

const id = 'signalk-to-mqtt';
const debug = require('debug')(id);
const mqtt = require('mqtt');
const NeDBStore = require('mqtt-nedb-store');
const fs = require('fs');
const filePath = require('path');
const sqlite3 = require('sqlite3');
const mypackage = require('./package.json');

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var started = false;
  var db;
  var client;
  var data = {
    name: app.getSelfPath('name'),
    mmsi: app.getSelfPath('mmsi'),
    clientId: app.getSelfPath('mmsi') || app.selfId,
    length: app.getSelfPath('design.length.value.overall'),
    beam: app.getSelfPath('design.beam.value'),
    height: app.getSelfPath('design.airHeight.value'),
    ship_type: app.getSelfPath('design.aisShipType.value.id'),
    version: mypackage.version,
    signalk_version: app.config.version
  };

  plugin.id = id;
  plugin.name = 'MQTT Publisher';
  plugin.description =
    'Signal K server plugin to send all self SignalK numeric data, navigation.position and navigation.attitude to MQTT';

  plugin.schema = {
    title: 'MQTT Publisher',
    type: 'object',
    required: ['remoteHost'],
    properties: {
      sendToRemote: {
        type: 'boolean',
        title: 'Send all self SignalK numeric data, navigation.position and navigation.attitude to an MQTT remote server',
        description:
          `clientId and topic prefix are set to vessels.${data.clientId}`,
        default: false,
      },
      remoteHost: {
        type: 'string',
        title: 'MQTT server Url (starts with mqtt/mqtts)',
        description:
          'MQTT server that the paths listed below should be sent to',
        default: 'mqtt://iot.example.com',
      },
      username: {
        type: "string",
        title: "MQTT server username"
      },
      password: {
        type: "string",
        title: "MQTT server password"
      },
      rejectUnauthorized: {
        type: "boolean",
        default: false,
        title: "Reject self signed and invalid server certificates"
      },
      retain: {
        type: "boolean",
        default: true,
        description: "new connected client which subscribes the topic will receive the retained message",
        title: "retain"
      },
      QoS: {
        type: "number",
        default: 1,
        title: "QoS",
        description: "todo"
      },
      sendInterval: {
        type: "number",
        title: 'How often to send data, in seconds',
        default: 60,
      },
      messageAsKey: {
          type: "boolean",
          title: "SendMessageAsKey",
          description: "Subscribe to: '+/signalk/key/#', eg: <client ID>/signalk/key/environment/depth/belowTransducer",
          default: false
      },
      messageAsDelta: {
          type: "boolean",
          title: "sendMessageAsDelta",
          description: "Subscribe to: '+/signalk/delta', eg: <client ID>/signalk/delta",
          default: true
      }
    },
  };

  let isfloatField = function(n) {
      return Number(n) === n;   
  }

  plugin.onStop = [];

  plugin.start = function(options) {
    app.debug(`${plugin.name} Started...`)
    app.setPluginStatus('Initializing');

    let dbFile= filePath.join(app.getDataDirPath(), 'mqttlogger.sqlite3');
    db = new sqlite3.Database(dbFile);
    db.run('CREATE TABLE IF NOT EXISTS buffer(ts REAL,' +
           '                                 topic REAL,' +
           '                                 message REAL)');

    if (options.sendToRemote) {
      const manager = NeDBStore(app.getDataDirPath());
      client = mqtt.connect(options.remoteHost, {
        rejectUnauthorized: options.rejectUnauthorized,
        reconnectPeriod: 60000,
        clientId: data.clientId,
        outgoingStore: manager.outgoing,
        username: options.username,
        password: options.password,
        clean: false
      });
      client.on('connect', (connack) => {
        app.setPluginStatus(`Connected to ${options.remoteHost}`);
        app.debug(`Connected to ${options.remoteHost}, clientId and topic prefix: vessels.${data.clientId}`);
      });
      client.on('error', (err) => {
        app.setPluginStatus(`Error ${err}`);
        app.debug(`Error ${err}`);
      });
      client.on('disconnect', (packet) => {
        app.setPluginStatus(`Disconnected from ${options.remoteHost}`);
        app.debug(`Disconnected from ${options.remoteHost}`);
      });
      client.on('reconnect', () => {
        app.setPluginStatus(`Reconnect started to ${options.remoteHost}`);
        app.debug(`Reconnect started to ${options.remoteHost}`);
      });
      client.on('offline', () => {
        app.setPluginStatus(`offline ${options.remoteHost}`);
        app.debug(`offline ${options.remoteHost}`);
      });
      startSending(options);
      plugin.onStop.push(_ => client.end());
    }
    app.setPluginStatus('Done initializing');
    started = true;
  };

  plugin.stop = function() {
    plugin.onStop.forEach(f => f());
  };

  return plugin;

  function startSending(options) {

    let localSubscription = {
      context: 'vessels.self', // Limit to self
      subscribe: [{
        path: '*', // Get all paths
        period: (options.sendInterval || POLL_INTERVAL) * 1000,
      }]
    };

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(u => {
          //if no u.values then return as there is no values to display
          if (!u.values) {
            return
          }
          processDelta(options, u.values[0], u.timestamp)
        });
      }
    );
  }

  function processDelta(options, delta, timestamp) {
    //console.log('processDelta');
    //app.debug(delta);
    //app.debug(timestamp);
    let path = delta.path;
    let value = delta.value;
    let message_arr = [];
    if (typeof value === 'object') {
      if (path === "navigation.position") {
          message_arr = [
            {path: "navigation.position.latitude", value: value['latitude'], timestamp: timestamp},
            {path: "navigation.position.longitude", value: value['longitude'], timestamp: timestamp}
          ];
      }
      else if (path === "navigation.attitude") {
          message_arr = [
            {path: "navigation.attitude.roll", value: values['roll'], timestamp: timestamp},
            {path: "navigation.attitude.pitch", value: values['pitch'], timestamp: timestamp},
            {path: "navigation.attitude.yaw", value: values['yaw'], timestamp: timestamp}
          ];
      } else {
          app.debug(`Skipping unsupported path '${path}'`)
          return
      }
    } else {
        if (isNaN(value) || !isfloatField(value) || !isFinite(value)) {
          app.debug(`Skipping path '${path}' because value is invalid, '${value}'`)
          return
        }
        else {
          message_arr = [
            {path: path, value: value, timestamp: timestamp}
          ];
        }
    }
    message_arr.forEach((element) => {
      //console.log(`mqtt message for '${element.path}'`);
      app.debug(`Sending mqtt message for '${element.path}'`);
      let message = craftMessage(element.timestamp, element.path, element.value);
      if (options.messageAsKey) {
        sendMessageAsDelta(message);
      }
      if (options.messageAsKey) {
        sendMessageAsKey(message, element.path);
      }
    });
  }

  function sendMessageAsDelta(m) {
    //console.log('sendMessageAsDelta');
    //app.debug(m);
    client.publish(
      'vessels.'+data.clientId+'/signalk/delta',
      JSON.stringify(m),
      { qos: 1, retain: true }
    );
  }

  function sendMessageAsKey(m,path) {
    //console.log('sendMessageAsKey');
    //app.debug(m);
    client.publish(
      'vessels.'+ data.clientId+ '/signalk/keys/'+ path.replace(/\./g, '/'),
      JSON.stringify(m),
      { qos: 1, retain: true }
    );
  }

  function craftMessage(timestamp, path, value) {
    //console.log('craftMessage');
    let message = {
        context: 'vessels.' + data.clientId,
        time: timestamp,
        path: path,
        value: value === null ? 'null' : value,
    };
    return message;
  }

};
