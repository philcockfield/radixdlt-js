import BN from 'bn.js'

import {
    includeDSON,
    includeJSON,
    RadixQuark,
    RadixSerializer,
    RadixBytes,
} from '..'
import { RadixUInt256 } from '../../../index';

export enum RadixFungibleType {
    MINT = <any>'minted',
    TRANSFER = <any>'transferred',
    BURN = <any>'burned',
}

/**
 * A quark that makes a particle fungible: can be cut up into pieces and put back together.
 */
@RadixSerializer.registerClass('FUNGIBLEQUARK')
export class RadixFungibleQuark extends RadixQuark {

    @includeDSON
    @includeJSON
    public planck: number

    @includeDSON
    @includeJSON
    public nonce: number

    @includeDSON
    @includeJSON
    public amount: RadixUInt256

    @includeDSON
    @includeJSON
    public type: RadixFungibleType

    constructor(amount: RadixUInt256, planck: number, nonce: number, type: RadixFungibleType) {
        super()
        this.amount = amount
        this.planck = planck
        this.nonce = nonce
        this.type = type
    }
}
