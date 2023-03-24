/*
 * Copyright (c) 2008-2022, Hazelcast, Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const { expect } = require('chai');
const fs = require('fs');
const Long = require('long');

const RC = require('../../../RC');
const { TopicOverloadPolicy, TopicOverloadError} = require('../../../../../lib');
const { ReliableTopicMessage } = require('../../../../../lib/proxy/topic/ReliableTopicMessage');
const TestUtil = require('../../../../TestUtil');

describe('ReliableTopicTest', function () {
    let cluster;
    let clientOne;
    let clientTwo;

    const testFactory = new TestUtil.TestFactory();

    function createConfig(clusterName, port) {
        return {
            clusterName,
            reliableTopics: {
                'discard': {
                    overloadPolicy: TopicOverloadPolicy.DISCARD_NEWEST
                },
                'overwrite': {
                    overloadPolicy: TopicOverloadPolicy.DISCARD_OLDEST
                },
                'error': {
                    overloadPolicy: TopicOverloadPolicy.ERROR
                },
                'block': {
                    overloadPolicy: TopicOverloadPolicy.BLOCK
                }
            },
            network: {
                clusterMembers: [`127.0.0.1:${port}`]
            }
        };
    }

    function generateItems(client, howMany) {
        const all = [];
        for (let i = 1; i <= howMany; i++) {
            const reliableTopicMessage = new ReliableTopicMessage();
            reliableTopicMessage.payload = client.getSerializationService().toData(i);
            reliableTopicMessage.publishTime = Long.fromNumber(new Date().getTime());
            reliableTopicMessage.publisherAddress = client.getLocalEndpoint().localAddress;
            all.push(reliableTopicMessage);
        }
        return all;
    }

    before(async function () {
        const memberConfig = fs.readFileSync(__dirname + '/hazelcast_topic.xml', 'utf8');
        cluster = await testFactory.createClusterForParallelTests(null, memberConfig);
        const member = await RC.startMember(cluster.id);
        const config = createConfig(cluster.id, member.port);
        clientOne = await testFactory.newHazelcastClientForParallelTests(config, member);
        clientTwo = await testFactory.newHazelcastClientForParallelTests(config, member);
    });

    after(async function () {
        await testFactory.shutdownAll();
    });

    it('writes and reads messages', function (done) {
        const topicName = 't' + Math.random();
        let topicOne;
        let topicTwo;
        clientOne.getReliableTopic(topicName).then((t) => {
            topicOne = t;
            return clientTwo.getReliableTopic(topicName);
        }).then((t) => {
            topicTwo = t;
            topicTwo.addMessageListener((msg) => {
                if (msg.messageObject['value'] === 'foo') {
                    done();
                }
            });
            setTimeout(() => {
                topicOne.publish({ 'value': 'foo' });
            }, 500);
        }).catch(done);
    });

    it('writes and reads messages with addListener method', async function () {
        const topicName = TestUtil.randomString(8)
        const topicOne = await clientOne.getReliableTopic(topicName);
        const topicTwo = await clientTwo.getReliableTopic(topicName);
        const deferredPromise = new Promise((resolve) => {
            topicTwo.addListener(async (msg) => {
                if (msg.messageObject['value'] !== 'foo') {
                    throw new Error('Message received does not match expected value.');
                }
                resolve();
            });
        });
        topicOne.publish({'value': 'foo'});
        await TestUtil.promiseWaitMilliseconds(500);

        await deferredPromise;
    });

    it('removed message listener does not receive items after removal', function (done) {
        const topicName = 't' + Math.random();
        let topicOne;
        let topicTwo;
        clientOne.getReliableTopic(topicName).then((topic) => {
            topicOne = topic;
            return clientTwo.getReliableTopic(topicName);
        }).then((topic) => {
            topicTwo = topic;
            let receivedMessages = 0;
            const id = topicTwo.addMessageListener(() => {
                receivedMessages++;
                if (receivedMessages > 2) {
                    done(new Error('Kept receiving messages after message listener is removed.'));
                }
            });

            topicOne.publish({ 'value0': 'foo0' });
            topicOne.publish({ 'value1': 'foo1' });
            setTimeout(() => {
                topicTwo.removeMessageListener(id);
                topicOne.publish({ 'value2': 'foo2' });
                topicOne.publish({ 'value3': 'foo3' });
                topicOne.publish({ 'value4': 'foo4' });
                topicOne.publish({ 'value5': 'foo5' });
                setTimeout(done, 500);
            }, 500);
        }).catch(done);
    });

    it('removed message listener does not receive items after removal with removeListener', async function() {
        const topicName = TestUtil.randomString(8)
        const topicOne = await clientOne.getReliableTopic(topicName);
        const topicTwo = await clientTwo.getReliableTopic(topicName);
        let receivedMessages = 0;
        const callback = () => {
            receivedMessages++;
            if (receivedMessages > 2) {
                throw new Error('Kept receiving messages after message listener is removed.');
            }
        };
        const id = await topicTwo.addListener(callback);

        topicOne.publish({ 'value0': 'foo0' });
        topicOne.publish({ 'value1': 'foo1' });

        topicTwo.removeListener(id);
        topicOne.publish({ 'value2': 'foo2' });
        topicOne.publish({ 'value3': 'foo3' });
        topicOne.publish({ 'value4': 'foo4' });
        topicOne.publish({ 'value5': 'foo5' });

        await TestUtil.promiseWaitMilliseconds(500);
    });

    it('blocks when there is no more space', async function () {
        const topic = await clientOne.getReliableTopic('block');
        const ringbuffer = topic.getRingbuffer();

        const capacity = await ringbuffer.capacity();
        const all = [];
        for (let i = 0; i < capacity.toNumber() + 1; i++) {
            all.push(i);
        }
        await ringbuffer.addAll(all);

        const startTime = Date.now();
        await topic.publish(-50);
        // Here we check that the call was indeed blocking
        // until the TTL of the first inserted entry has passed
        const elapsed = Date.now() - startTime;
        if (elapsed <= 2000) {
            throw new Error('Message was published too fast, expected at least a 2 second delay, got: ' + elapsed);
        }
    });

    it('continues operating when stale sequence is reached', function (done) {
        let topic;
        let ringbuffer;
        clientOne.getReliableTopic('stale').then((t) => {
            topic = t;
            return topic.getRingbuffer();
        }).then((rb) => {
            ringbuffer = rb;
            topic.addMessageListener((m) => {
                if (m.messageObject === 20) {
                    done();
                }
            });
            const all = generateItems(clientOne, 20);
            ringbuffer.addAll(all);
        }).catch(done);
    });

    it('discards the item when there is no more space', async function () {
        const topic = await clientOne.getReliableTopic('discard');
        const ringbuffer = topic.getRingbuffer();

        const all = generateItems(clientOne, 10);
        await ringbuffer.addAll(all);
        await topic.publish(11);

        const seq = await ringbuffer.tailSequence();
        const item = await ringbuffer.readOne(seq);
        const obj = clientOne.getSerializationService().toObject(item.payload);
        expect(obj).to.equal(10);
    });

    it('overwrites the oldest item when there is no more space', async function () {
        const topic = await clientOne.getReliableTopic('overwrite');
        const ringbuffer = topic.getRingbuffer();

        const all = generateItems(clientOne, 10);
        await ringbuffer.addAll(all);
        await topic.publish(11);

        const seq = await ringbuffer.tailSequence();
        const item = await ringbuffer.readOne(seq);
        const obj = clientOne.getSerializationService().toObject(item.payload);
        expect(obj).to.equal(11);
    });

    it('whenDiscardNewest_whenNoSpace_all', async function () {
        const topic = await clientOne.getReliableTopic('discard');
        const ringbuffer = topic.getRingbuffer();

        const CAPACITY = 10;

        const itemList1 = [...Array(CAPACITY).keys()].map(i => i + 1);
        const itemList2 = [...Array(CAPACITY).keys()].map((i) => i + CAPACITY + 1);

        await topic.publishAll(itemList1);
        await topic.publishAll(itemList2);

        const seq = await ringbuffer.tailSequence();
        const item = await ringbuffer.readOne(seq);
        const obj = clientOne.getSerializationService().toObject(item.payload);
        expect(obj).to.equal(CAPACITY);

        const readCount = await ringbuffer.size();
        expect(readCount.toNumber()).to.equal(CAPACITY);

        const head = await ringbuffer.headSequence();
        const items = await ringbuffer.readMany(head, CAPACITY, 2 * CAPACITY);
        const objects = [];
        for (let i = 0; i < CAPACITY; i++) {
            objects.push(clientOne.getSerializationService().toObject(items.get(i).payload));
        }
        expect(objects).to.deep.equal(itemList1);
    });

    it('whenDiscardOldest_whenNoSpace_all', async function () {
        const topic = await clientOne.getReliableTopic('overwrite');
        const ringbuffer = topic.getRingbuffer();

        const CAPACITY = 10;

        const itemList1 = [...Array(CAPACITY).keys()].map(i => i + 1);
        const itemList2 = [...Array(CAPACITY).keys()].map((i) => i + CAPACITY + 1);

        await topic.publishAll(itemList1);
        await topic.publishAll(itemList2);

        const seq = await ringbuffer.tailSequence();
        const item = await ringbuffer.readOne(seq);
        const obj = clientOne.getSerializationService().toObject(item.payload);
        expect(obj).to.equal(2 * CAPACITY);

        const readCount = await ringbuffer.size();
        expect(readCount.toNumber()).to.equal(CAPACITY);

        const head = await ringbuffer.headSequence();
        const items = await ringbuffer.readMany(head, CAPACITY, 2 * CAPACITY);
        const objects = [];
        for (let i = 0; i < CAPACITY; i++) {
            objects.push(clientOne.getSerializationService().toObject(items.get(i).payload));
        }
        expect(objects).to.deep.equal(itemList2);
    });

    it('whenBlock_whenNoSpace_all', async function () {
        const topic = await clientOne.getReliableTopic('block');
        const ringbuffer = topic.getRingbuffer();

        const CAPACITY = 10;

        const itemList1 = [...Array(CAPACITY).keys()].map(i => i + 1);
        const itemList2 = [...Array(CAPACITY).keys()].map((i) => i + CAPACITY + 1);

        await topic.publishAll(itemList1);

        const beginTime = Date.now();
        await topic.publishAll(itemList2);
        const timePassed = Date.now() - beginTime;

        expect(timePassed).to.be.greaterThan(2000);

        const readCount = await ringbuffer.size();
        expect(readCount.toNumber()).to.equal(CAPACITY);

        const head = await ringbuffer.headSequence();
        const items = await ringbuffer.readMany(head, CAPACITY, CAPACITY);
        const objects = [];
        for (let i = 0; i < CAPACITY; i++) {
            objects.push(clientOne.getSerializationService().toObject(items.get(i).payload));
        }
        expect(objects).to.deep.equal(itemList2);
    });

    it('whenError_andNoSpace_all', async function () {
        const topic = await clientOne.getReliableTopic('error');
        const ringbuffer = topic.getRingbuffer();

        const CAPACITY = 10;

        const itemList1 = [...Array(CAPACITY).keys()].map(i => i + 1);
        const itemList2 = [...Array(CAPACITY).keys()].map((i) => i + CAPACITY + 1);

        await topic.publishAll(itemList1);

        try {
            await topic.publishAll(itemList2);
        } catch (e) {
            expect(e).to.be.instanceOf(TopicOverloadError);
        }

        const readCount = await ringbuffer.size();
        expect(readCount.toNumber()).to.equal(CAPACITY);

        const seq = await ringbuffer.headSequence();
        const items = await ringbuffer.readMany(seq, CAPACITY, 2 * CAPACITY);
        const objects = [];
        for (let i = 0; i < CAPACITY; i++) {
            objects.push(clientOne.getSerializationService().toObject(items.get(i).payload));
        }
        expect(objects).to.deep.equal(itemList1);
    });
});
