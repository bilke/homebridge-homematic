'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const hap = require('@homebridge/hap-nodejs')
const thermostatFiles = [
  'HomeMaticHomeKitThermostatServiceIP.js',
  'HomeMaticHomeKitThermalControlService.js',
  'HomeMaticHomeKitThermostatService.js',
  'HomeMaticHomeKitIPThermostatService.js'
]

// Load the real entry point while excluding CCU transports and storage. The
// unsupported API version stops construction immediately after HAP setup.
function initialiseHap (apiHap) {
  let Platform
  const homebridge = {
    hap: apiHap,
    user: { storagePath: () => '/tmp' },
    registerPlatform: (plugin, name, constructor) => { Platform = constructor }
  }
  const entry = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8'), {
    module: entry,
    global: {},
    require: name => name.startsWith('./') ? { HomeMaticCacheManager: function () {} } : require(name)
  })
  entry.exports(homebridge)
  assert.throws(() => new Platform({}, {}, { hap: apiHap, version: 2.0 }), /Unexpected API version/)
  return homebridge
}

function buildThermostat (file, homebridge) {
  const serviceModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../ChannelServices', file), 'utf8'), {
    module: serviceModule,
    require: name => name === './HomeKitGenericService.js' ? { HomeKitGenericService: function () {} } : require(name)
  })
  const History = require('fakegato-history')(homebridge)
  const device = {
    name: 'Test Thermostat',
    adress: 'HmIP-RF.TEST:1',
    type: 'CLIMATECONTROL_RT_TRANSCEIVER',
    services: [],
    currentStateCharacteristic: {},
    log: { debug: () => {} },
    platform: { registerAdressForEventProcessingAtAccessory: () => {} },
    setCurrentStateCharacteristic: () => {},
    cleanVirtualDevice: () => {},
    remoteGetValue: () => {},
    queryData: () => {},
    enableLoggingService: function () {
      this.services.push(new History('thermo', { displayName: this.name }, { disableTimer: true }))
    }
  }
  serviceModule.exports.prototype.createDeviceService.call(device, hap.Service, hap.Characteristic)
  return device.services
}

describe('Homebridge 2 HAP permission compatibility', function () {
  it('keeps thermostat and bundled history permissions valid with modern HAP enums', async function () {
    const homebridge = initialiseHap(hap)
    for (const file of thermostatFiles) {
      const services = buildThermostat(file, homebridge)
      let iid = 1
      for (const service of services) {
        for (const characteristic of service.characteristics) {
          characteristic.iid = iid++
          const wire = JSON.parse(JSON.stringify(await characteristic.toHAP(undefined, false)))
          assert.ok(wire.perms.every(p => ['pr', 'pw', 'ev', 'aa', 'tw', 'hd', 'wr'].includes(p)),
            file + ': invalid permissions for ' + characteristic.displayName)
        }
      }
      const thermostat = services.find(service => service instanceof hap.Service.Thermostat)
      const target = thermostat.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      assert.deepStrictEqual(Array.from(target.props.perms), ['pr', 'pw', 'ev'])
      assert.ok('value' in await target.toHAP(undefined, false), 'target mode must advertise a readable value')
    }
  })

  it('advertises only off and heat within the target mode range', function () {
    const homebridge = initialiseHap(hap)
    for (const file of thermostatFiles) {
      const thermostat = buildThermostat(file, homebridge).find(service => service instanceof hap.Service.Thermostat)
      const props = thermostat.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).props
      assert.deepStrictEqual(Array.from(props.validValues), [0, 1], file)
    }
  })

  it('preserves the legacy Homebridge permission enum', function () {
    const perms = { READ: 'pr', WRITE: 'pw', NOTIFY: 'ev', HIDDEN: 'hd' }
    const legacyHap = { Characteristic: { Formats: {}, Units: {}, Perms: perms } }
    initialiseHap(legacyHap)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(legacyHap.Characteristic.Perms)), perms)
  })
})
