import { BehaviorSubject, Subject } from 'rxjs/Rx'
import { Client } from 'rpc-websockets'

import RadixNode from './RadixNode'

import { RadixAtom, RadixEUID, RadixSerializer, RadixAtomUpdate } from '../atommodel'
import { logger } from '../common/RadixLogger'

import events from 'events'

import fs from 'fs'

interface Notification {
    subscriberId: number
}

interface AtomReceivedNotification extends Notification {
    atoms: any[],
    isHead: boolean,
}

interface AtomSubmissionStateUpdateNotification extends Notification {
    value: string
    message?: string
}

export declare interface RadixNodeConnection {
    on(event: 'closed' | 'open', listener: () => void): this
}

export class RadixNodeConnection extends events.EventEmitter {
    private pingInterval

    private _socket: Client
    private _subscriptions: { [subscriberId: string]: Subject<RadixAtomUpdate> } = {}
    private _atomUpdateSubjects: { [subscriberId: string]: BehaviorSubject<any> } = {}

    private _addressSubscriptions: { [address: string]: string } = {}
    private _syncedSubscriptions: { [subscriberId: number]: BehaviorSubject<boolean> } = {}

    private lastSubscriberId = 1

    public address: string

    constructor(readonly node: RadixNode, readonly nodeRPCAddress: (nodeIp: string) => string) {
        super()
        this.node = node
    }

    private getSubscriberId() {
        this.lastSubscriberId++
        return this.lastSubscriberId + ''
    }

    /**
     * Check whether the node connection is ready for requests
     * @returns true if ready
     */
    public isReady(): boolean {
        return this._socket && this._socket.ready
    }

    private ping = () => {
        if (this.isReady()) {
            this._socket
            .call('Network.getInfo', { id: 0 }).then((response: any) => {
                logger.debug(`Ping`, response)
            }).catch((error: any) => {
                logger.warn(`Error sending ping`, error)
            })
        }
    }

    /**
     * Opens connection
     * @returns a promise that resolves once the connection is ready, or rejects on error or timeout
     */
    public async openConnection(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.address = this.nodeRPCAddress(this.node.host.ip)

            // For testing atom queueing during connection issues
            // if (Math.random() > 0.1) {
            //    this.address += 'garbage'
            // }

            logger.info(`Connecting to ${this.address}`)

            this._socket = new Client(this.address, { reconnect: false })

            this._socket.on('close', this._onClosed)

            this._socket.on('error', error => {
                logger.error(error)
                reject(error)
            })

            setTimeout(() => {
                if (!this._socket.ready) {
                    logger.debug('Socket timeout')
                    this._socket.close()
                    this.emit('closed')
                    reject('Timeout')
                }
            }, 5000)

            this._socket.on('open', () => {
                logger.info(`Connected to ${this.address}`)

                this.pingInterval = setInterval(this.ping, 10000)

                this.emit('open')

                this._socket.on('Atoms.subscribeUpdate', this._onAtomReceivedNotification)
                this._socket.on('AtomSubmissionState.onNext', this._onAtomSubmissionStateUpdate)

                resolve()
            })
        })
    }

    /**
     * Subscribe for all existing and future atoms for a given address
     * 
     * @param address Base58 formatted address
     * @returns A stream of atoms
     */
    public subscribe(address: string): Subject<RadixAtomUpdate> {
        const subscriberId = this.getSubscriberId()

        this._addressSubscriptions[address] = subscriberId
        this._subscriptions[subscriberId] = new Subject<RadixAtomUpdate>()
        this._syncedSubscriptions[subscriberId] = new BehaviorSubject<boolean>(false)

        this._socket
            .call('Atoms.subscribe', {
                subscriberId,
                query: {
                    address,
                },
                debug: true,
            })
            .then((response: any) => {
                logger.info(`Subscribed for address ${address}`, response)
            })
            .catch((error: any) => {
                logger.error(`Error subscribing for address ${address}`, error)
                
                this._subscriptions[subscriberId].error(error)
            })

        return this._subscriptions[subscriberId]
    }

    /**
     * Unsubscribe for all existing and future atoms for a given address
     * 
     * @param address - Base58 formatted address
     * @returns A promise with the result of the unsubscription call
     */
    public unsubscribe(address: string): Promise<any> {
        const subscriberId = this._addressSubscriptions[address]

        return new Promise<any>((resolve, reject) => {
            this._socket
                .call('Atoms.cancel', {
                    subscriberId,
                })
                .then((response: any) => {
                    logger.info(`Unsubscribed for address ${address}`)
                    
                    delete this._addressSubscriptions[address]

                    this._subscriptions[subscriberId].complete()

                    resolve(response)
                })
                .catch((error: any) => {
                    reject(error)
                })
        })
    }

    /**
     * Returns true if the atoms reading is in synced with the last atom in the ledger
     * 
     * @param address - Base58 formatted address
     * @returns A promise with true or false
     */
    public isSynced(address: string): Subject<boolean> {
        const subscriberId = this._addressSubscriptions[address]

        return this._syncedSubscriptions[subscriberId]
    }

    /**
     * Unsubscribes to all the addresses this node is subscribed to
     * 
     * @returns An array with the result of each unsubscription
     */
    public unsubscribeAll(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const unsubscriptions = new Array<Promise<any>>()
            for (const address in this._addressSubscriptions) {
                unsubscriptions.push(this.unsubscribe(address))
            }
    
            Promise.all(unsubscriptions)
                .then((values) => {
                    resolve(values)
                })
                .catch((error) => {
                    reject(error)
                })
        })
    }

    /**
     * Submit an atom to the ledger
     * 
     * @param atom - The atom to be submitted
     * @returns A stream of the status of the atom submission
     */
    public submitAtom(atom: RadixAtom) {

        // // Store atom for testing
        // let jsonPath = path.join('./submitAtom.json')
        // logger.info(jsonPath)
        // fs.writeFile(jsonPath, JSON.stringify(atom.toJSON()), (error) => {
        //    // Throws an error, you could also catch it here
        //    if (error) { throw error }

        //    // Success case, the file was saved
        //    logger.info('Atom saved!')
        // })

        const subscriberId = this.getSubscriberId()

        const atomStateSubject = new BehaviorSubject('CREATED')
        
        this._atomUpdateSubjects[subscriberId] = atomStateSubject

        const timeout = setTimeout(() => {
            this._socket.close()
            atomStateSubject.error('Socket timeout')
        }, 5000)


        const atomJSON = atom.toJSON()
        logger.debug(atomJSON)

        this._socket
            .call('Universe.submitAtomAndSubscribe', {
                subscriberId,
                atom: atomJSON,
            })
            .then(() => {
                clearTimeout(timeout)
                atomStateSubject.next('SUBMITTED')
            })
            .catch((error: any) => {
                clearTimeout(timeout)
                atomStateSubject.error(error)
            })

        return atomStateSubject
    }

    /**
     * NOT IMPLEMENTED
     * Query the ledger for an atom by its id
     * @param id
     * @returns The atom
     */
    public async getAtomById(id: RadixEUID) {
        // TODO: everything
        return this._socket
            .call('Atoms.getAtomInfo', { id: id.toJSON() })
            .then((response: any) => {
                return RadixSerializer.fromJSON(response.result) as RadixAtom
            })
    }

    public close = () => {
        this._socket.close()
    }

    private _onClosed = () => {
        logger.info('Socket closed')

        clearInterval(this.pingInterval)

        // Close subject
        for (const subscriberId in this._subscriptions) {
            const subscription = this._subscriptions[subscriberId]
            if (!subscription.closed) {
                subscription.error('Socket closed')
            }
        }

        for (const subscriberId in this._atomUpdateSubjects) {
            const subject = this._atomUpdateSubjects[subscriberId]
            if (!subject.closed) {
                subject.error('Socket closed')
            }
        }

        this.emit('closed')
    }

    private _onAtomSubmissionStateUpdate = (notification: AtomSubmissionStateUpdateNotification,) => {
        logger.info('Atom Submission state update', notification)

        // Handle atom state update
        const subscriberId = notification.subscriberId
        const value = notification.value
        const message = notification.message
        const subject = this._atomUpdateSubjects[subscriberId]

        switch (value) {
            case 'SUBMITTING':
            case 'SUBMITTED':
                subject.next(value)
                break
            case 'STORED':
                subject.next(value)
                subject.complete()
                break
            case 'COLLISION':
            case 'ILLEGAL_STATE':
            case 'UNSUITABLE_PEER':
            case 'VALIDATION_ERROR':
                subject.error(value + ': ' + message)
                break
        }
    }

    private _onAtomReceivedNotification = (notification: AtomReceivedNotification) => {
        logger.info('Atoms received', notification)

        // Store atom for testing
        // const jsonPath = `./atomNotification-${Math.random().toString(36).substring(6)}.json`
        // // let jsonPath = path.join(__dirname, '..', '..', '..', '..', 'atomNotification.json')
        // logger.info(jsonPath)
        // fs.writeFile(jsonPath, JSON.stringify(notification), (error) => {
        //    // Throws an error, you could also catch it here
        //    if (error) { throw error }

        //    // Success case, the file was saved
        //    logger.info('Atoms saved!')
        // })

        const deserializedAtoms = RadixSerializer.fromJSON(notification.atoms) as RadixAtom[]
        const isHead = notification.isHead

        logger.info(deserializedAtoms)

        // Check HIDs for testing
        for (let i = 0; i < deserializedAtoms.length; i++) {
            const deserializedAtom = deserializedAtoms[i]
            const serializedAtom = notification.atoms[i]

            if (serializedAtom.hid && deserializedAtom.hid.equals(RadixEUID.fromJSON(serializedAtom.hid))) {
                logger.info('HID match')
            } else if (serializedAtom.hid) {
                logger.error('HID mismatch')
            }
        }

        // Forward atoms to correct wallets
        const subscription = this._subscriptions[notification.subscriberId]
        for (const atom of deserializedAtoms) {
            subscription.next({ // This is a temporary solution, in future nodes will return AtomUpdates rather than just Atoms
                action: 'STORE',
                atom,
                processedData: {},
            })
        }

        this._syncedSubscriptions[notification.subscriberId].next(isHead)
    }
}

export default RadixNodeConnection
