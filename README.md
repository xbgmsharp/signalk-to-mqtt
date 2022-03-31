# Signal K to MQTT

Signal K server plugin to send all self SignalK numeric data, `navigation.position` and `navigation.attitude` to MQTT.

SendMessageAsKey
 * Subscribe to: `+/signalk/key/#`, eg: `<client ID>/signalk/key/environment/depth/belowTransducer`

sendMessageAsDelta:
 * Subscribe to: `+/signalk/delta`, eg: `<client ID>/signalk/delta`

The `<client ID>` must be unique, so it use your Signal K UUID or your MMSI.
