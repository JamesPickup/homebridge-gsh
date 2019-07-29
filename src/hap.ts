import { HAPNodeJSClient } from 'hap-node-client';
import { ServicesTypes, Service, Characteristic } from './hap-types';
import * as crypto from 'crypto';

import { Door } from './types/door';
import { Fan } from './types/fan';
import { GarageDoorOpener } from './types/garage-door-opener';
import { Lightbulb } from './types/lightbulb';
import { LockMechanism } from './types/lock-mechanism';
import { Switch } from './types/switch';
import { Window } from './types/window';
import { WindowCovering } from './types/window-covering';
import { Thermostat } from './types/thermostat';

export class Hap {
  log;
  homebridge: HAPNodeJSClient;
  services: Array<any> = [];

  /* init types */
  types = {
    Door: new Door(),
    Fan: new Fan(),
    GarageDoorOpener: new GarageDoorOpener(),
    Lightbulb: new Lightbulb(),
    LockMechanism: new LockMechanism(),
    Outlet: new Switch('action.devices.types.OUTLET'),
    Switch: new Switch('action.devices.types.SWITCH'),
    Thermostat: new Thermostat(),
    Window: new Window(),
    WindowCovering: new WindowCovering(),
  };

  constructor(log, pin, debug) {
    this.log = log;

    this.homebridge = new HAPNodeJSClient({
      debug,
      pin,
      timeout: 5,
    });

    this.homebridge.once('Ready', () => {
      this.log.info(`Finished instance discovery`);
    });

    this.homebridge.on('Ready', () => {
      this.start();
    });
  }

  /**
   * Start processing
   */
  async start() {
    await this.getAccessories();
    await this.buildSyncResponse();
  }

  /**
   * Build Google SYNC intent payload
   */
  async buildSyncResponse() {
    const devices = this.services.map((service) => {
      return this.types[service.serviceType].sync(service);
    });
    return devices;
  }

  async query(devices) {
    const response = {};

    for (const device of devices) {
      const service = this.services.find(x => x.uniqueId === device.id);
      if (service) {
        await this.getStatus(service);
        response[device.id] = this.types[service.serviceType].query(service);
      } else {
        response[device.id] = {};
      }
    }

    return response;
  }

  async execute(commands) {
    const response = [];

    for (const command of commands) {
      for (const device of command.devices) {

        const service = this.services.find(x => x.uniqueId === device.id);

        if (service) {
          const payload = this.types[service.serviceType].execute(service, command);

          await new Promise((resolve, reject) => {
            this.homebridge.HAPcontrol(service.instance.ipAddress, service.instance.port, JSON.stringify(payload), (err) => {
              if (!err) {
                response.push({
                  ids: [device.id],
                  status: 'SUCCESS',
                });
              } else {
                this.log.error('Failed to control an accessory. Make sure all your Homebridge instances are using the same PIN.');
                this.log.error(err.message);
                response.push({
                  ids: [device.id],
                  status: 'ERROR',
                });
              }
              return resolve();
            });
          });

        }

      }
    }
    return response;
  }

  async getStatus(service) {
    const iids: number[] = service.characteristics.map(c => c.iid);

    const body = '?id=' + iids.map(iid => `${service.aid}.${iid}`).join(',');

    const characteristics = await new Promise((resolve, reject) => {
      this.homebridge.HAPstatus(service.instance.ipAddress, service.instance.port, body, (err, status) => {
        if (err) {
          return reject(err);
        }
        return resolve(status.characteristics);
      });
    }) as Array<any>;

    for (const c of characteristics) {
      const characteristic = service.characteristics.find(x => x.iid === c.iid);
      characteristic.value = c.value;
    }
  }

  /**
   * Load accessories from Homebridge
   */
  async getAccessories() {
    return new Promise((resolve, reject) => {
      this.homebridge.HAPaccessories(async (instances) => {
        this.services = [];

        for (const instance of instances) {
          await this.parseAccessories(instance);
        }

        return resolve(true);
      });
    });
  }

  async parseAccessories(instance) {
    instance.accessories.accessories.forEach((accessory) => {
      // get accessory information service
      const accessoryInformationService = accessory.services.find(x => x.type === Service.AccessoryInformation);
      const accessoryInformation = {};

      if (accessoryInformationService && accessoryInformationService.characteristics) {
        accessoryInformationService.characteristics.forEach((c) => {
          if (c.value) {
            accessoryInformation[c.description] = c.value;
          }
        });
      }

      // discover the service type
      accessory.services
        .filter(x => x.type !== Service.AccessoryInformation)
        .filter(x => ServicesTypes[x.type])
        .filter(x => this.types.hasOwnProperty(ServicesTypes[x.type]))
        .forEach((service) => {
          service.accessoryInformation = accessoryInformation;
          service.aid = accessory.aid;
          service.serviceType = ServicesTypes[service.type];

          service.instance = {
            ipAddress: instance.ipAddress,
            port: instance.instance.port,
            username: instance.instance.txt.id,
          };

          // generate unique id for service
          service.uniqueId = crypto.createHash('sha256')
            .update(`${service.instance.username}${service.aid}${service.iid}${service.type}`)
            .digest('hex');

          // discover name of service
          const serviceNameCharacteristic = service.characteristics.find(x => [
            Characteristic.Name,
            Characteristic.ConfiguredName,
          ].includes(x.type));

          service.serviceName = serviceNameCharacteristic ?
            serviceNameCharacteristic.value : service.accessoryInformation.Name || service.serviceType;

          this.services.push(service);
        });
    });
  }
}
