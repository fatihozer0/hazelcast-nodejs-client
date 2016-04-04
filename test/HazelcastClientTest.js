var expect = require('chai').expect;
var Config = require('../lib/Config');
var Controller = require('./RC');
var HazelcastClient = require('../lib/HazelcastClient');
var Q = require('q');
describe('HazelcastClient', function() {
    this.timeout(4000);
    var cluster;
    var client;

    before(function() {
        return Controller.createCluster(null, null).then(function(res) {
            cluster = res;
            return Controller.startMember(cluster.id);
        }).then(function (member) {
            return HazelcastClient.newHazelcastClient();
        }).then(function(res) {
            client = res;
        });
    });

    after(function() {
        client.shutdown();
        return Controller.shutdownCluster(cluster.id);
    });

    it('getDistributedObject returns empty array when there is no distributed object', function() {
        return client.getDistributedObjects().then(function(distributedObjects) {
            return Q.all([
                expect(distributedObjects).to.be.an('array'),
                expect(distributedObjects).to.be.empty
            ]);
        });
    });

    describe('create many maps', function() {
        before(function(done) {
            var map0 = client.getMap('map0');
            var map1 = client.getMap('map1');
            var map2 = client.getMap('map2');
            var map3 = client.getMap('map3');
            var map4 = client.getMap('map4');

            done();
        });

        it('getDistributedObjects returns an array of distributed objects', function() {
            this.timeout(100000);
            var equalChecker = function(expected, actual) {
                return expect(actual).to.eq(expected);
            };
            return client.getDistributedObjects().then(function(distributedObjects) {
                var objects = {};
                distributedObjects.forEach(function(distObject) {
                    objects[distObject.getName()] = 'exist';
                });
                return Q.all([
                    expect(objects).to.have.property('map0'),
                    expect(objects).to.have.property('map1'),
                    expect(objects).to.have.property('map2'),
                    expect(objects).to.have.property('map3'),
                    expect(objects).to.have.property('map4')
                ]);
            });
        });
    });
});
