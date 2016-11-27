'use strict';

const promise_utils = require('../../util/promise_utils');
var dotenv = require('dotenv');
// const gcops = require('../qa/gcops');
const argv = require('minimist')(process.argv);
// var google = require('googleapis');

var AzureFunctions = require('./azureFunctions');
var GcloudFunctions = require('./gcloudFunctions');

var vm_prefix = argv.vm_prefix || 'agent-';
var zone = argv.zone || 'eastus';
var project = argv.project || 'QA-HA-resources';

var min_timeout = argv.min_timeout || 10; // minimum 20 seconds
var max_timeout = argv.max_timeout || 30; // maximum 1 minute
var min_machines = argv.min_machines || 2; // minimum 3 machine
var max_machines = argv.max_machines || 3; // maximum 10 machines
var service = argv.service || 'azure';

dotenv.load();
var account_email = argv.account || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
var account_key = argv.key_file || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

var clientId = process.env.CLIENT_ID;
var domain = process.env.DOMAIN;
var secret = process.env.APPLICATION_SECRET;
var subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;

var funcs = null;
if (service === 'gcloud') {
    funcs = new GcloudFunctions(account_email, account_key, project, zone);
} else {
    funcs = new AzureFunctions(clientId, domain, secret, subscriptionId, project, zone);
}

// var authClient = new google.auth.JWT(
//     account_email, account_key, null, ['https://www.googleapis.com/auth/compute']);
var machines_number = 0;
return funcs.authenticate()
    .then(() => funcs.countOnMachines(vm_prefix))
    .then(count => {
        machines_number = count;
        return promise_utils.pwhile(() => true, () => {
            var rand_machine;
            var rand_timeout = Math.floor(Math.random() * (max_timeout - min_timeout) + min_timeout);
            console.log('Number of ON machines are: ' + machines_number);
            return funcs.getRandomMachine(vm_prefix)
                .then(machine => {
                    rand_machine = machine;
                    console.log('Sleeping for ' + rand_timeout + ' seconds');
                    return funcs.getMachineStatus(rand_machine);
                })
                .delay(rand_timeout * 1000) // sleep for timeout in milliseconds
                .then(status => {
                    if ((status === 'VM stopped') && (machines_number < max_machines)) {
                        console.log('Turning ON machine: ' + rand_machine);
                        machines_number++;
                        return funcs.startVirtualMachine(rand_machine)
                            .then(() => funcs.waitMachineState(rand_machine, 'VM running'));
                    } else if ((status === 'VM running') && (machines_number > min_machines)) {
                        console.log('Turning OFF machine: ' + rand_machine);
                        machines_number--;
                        return funcs.stopVirtualMachine(rand_machine)
                            .then(() => funcs.waitMachineState(rand_machine, 'VM stopped'));
                    }
                });
        });
    });
