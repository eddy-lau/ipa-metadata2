'use strict';

var async = require('async');
var plist = require('simple-plist');
var decompress = require('decompress-zip');
var provisioning = require('@stendahls/provision-parse');
var entitlements = require('entitlements');

var rimraf = require('rimraf');
var tmp = require('temporary');
var glob = require("glob");
var Path = require('path');

module.exports = function (file, callback){
  var data = {};
  var output = new tmp.Dir();

  var unzipper = new decompress(file);
  unzipper.extract({
    path: output.path
  });

  unzipper.on('error', cleanUp);
  unzipper.on('extract', function(log) {
    var path = glob.sync(output.path + '/Payload/*/')[0];
    var hasProvision = false;

    for(var i = 0; i < log.length; i = i + 1){
      if(!log[i].deflated){
        continue;
      }

      if(log[i].deflated.indexOf('embedded.mobileprovision') === -1){
        continue;
      }

      hasProvision = true;
      break;
    }

    async.parallel([
      function(asyncCallback){
        plist.readFile(Path.join(path, 'Info.plist'), function(plistReadError, plistData) {
          if (plistReadError) {
            return asyncCallback(plistReadError);
          }
          data.metadata = plistData;

          return asyncCallback();
        });
      },
      function(asyncCallback){
        if(!hasProvision){
            return asyncCallback();
        }

        provisioning(Path.join(path, 'embedded.mobileprovision'), (provisionError, provisionData) => {
          if(provisionError){
            return asyncCallback(provisionError);
          }

          data.provisioning = provisionData;

          // Hard to serialize and it looks messy in output
          delete data.provisioning.DeveloperCertificates;

          return asyncCallback();
        });
      },
      function(asyncCallback){
        // `entitlements` relies on a OS X only CLI tool called `codesign`
        if(process.platform !== 'darwin'){
          return asyncCallback();
        }

        // provisioning uses cert-download which escapes paths with ""
        // if we ALSO escape with \\ that breaks the command
        path = path.replace(/ /g, '\\ ');

        entitlements(path, (entitlementsError, entitlementsData) => {
          if(entitlementsError){
            // Don't try to set entitlements for stuff that's not signed
            if(entitlementsError.message.indexOf('code object is not signed at all') > -1){
              return asyncCallback();
            }

            return asyncCallback(entitlementsError);
          }

          // Will be undefined on non-OSX platforms
          data.entitlements = entitlementsData

          return asyncCallback();
        });
      }
    ], function(error){
      return cleanUp(error);
    });
  });

  function cleanUp(error){
    rimraf.sync(output.path);
    return callback(error, data);
  }
};
