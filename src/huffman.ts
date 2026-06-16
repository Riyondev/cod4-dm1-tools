/**
 * Quake3-style adaptive Huffman decompressor, seeded with the CoD4 frequency
 * table. This is a faithful port of the decompressor half of
 * Iswenzz/CoD4-DM1 `Crypt/Huffman.cpp` (itself derived from id Software's
 * huffman.c). Only decompression is needed to read demos.
 */

const HMAX = 256;
const NYT = HMAX; // Not Yet Transmitted
const INTERNAL_NODE = HMAX + 1;

// CoD4 symbol frequency table (weights used to seed the adaptive tree).
const MSG_HDATA_COD4 = [
  274054, 68777, 40460, 40266, 48059, 39006, 48630, 27692, 17712, 15439, 12386, 10758, 9420, 9979,
  9346, 15256, 13184, 14319, 7750, 7221, 6095, 5666, 12606, 7263, 7322, 5807, 11628, 6199, 7826,
  6349, 7698, 9656, 28968, 5164, 13629, 6058, 4745, 4519, 5199, 4807, 5323, 3433, 3455, 3563, 6979,
  5229, 5002, 4423, 14108, 13631, 11908, 11801, 10261, 7635, 7215, 7218, 9353, 6161, 5689, 4649,
  5026, 5866, 8002, 10534, 15381, 8874, 11798, 7199, 12814, 6103, 4982, 5972, 6779, 4929, 5333,
  3503, 4345, 6098, 14117, 16440, 6446, 3062, 4695, 3085, 4198, 4013, 3878, 3414, 5514, 4092, 3261,
  4740, 4544, 3127, 3385, 7688, 11126, 6417, 5297, 4529, 6333, 4210, 7056, 4658, 6190, 3512, 2843,
  3479, 9369, 5203, 4980, 5881, 7509, 4292, 6097, 5492, 4648, 2996, 4988, 4163, 6534, 4001, 4342,
  4488, 6039, 4827, 7112, 8654, 26712, 8688, 9677, 9368, 7209, 3399, 4473, 4677, 11087, 4094, 3404,
  4176, 6733, 3702, 11420, 4867, 5968, 3475, 3722, 3560, 4571, 2720, 3189, 3099, 4595, 4044, 4402,
  3889, 4989, 3186, 3153, 5387, 8020, 3322, 3775, 2886, 4191, 2879, 3110, 2576, 3693, 2436, 4935,
  3017, 3538, 5688, 3444, 3410, 9170, 4708, 3425, 3273, 3684, 4564, 6957, 4817, 5224, 3285, 3143,
  4227, 5630, 6053, 5851, 6507, 13692, 8270, 8260, 5583, 7568, 4082, 3984, 4574, 6440, 3533, 2992,
  2708, 5190, 3889, 3799, 4582, 6020, 3464, 4431, 3495, 2906, 2243, 3856, 3321, 8759, 3928, 2905,
  3875, 4382, 3885, 5869, 6235, 10685, 4433, 4639, 4305, 4683, 2849, 3379, 4684, 5477, 4127, 3853,
  3515, 4913, 3601, 5237, 6617, 9019, 4857, 4112, 5180, 5998, 4925, 4986, 6365, 7930, 5948, 8085,
  7732, 8643, 8901, 9653, 32647,
];

interface HNode {
  left: HNode | null;
  right: HNode | null;
  parent: HNode | null;
  next: HNode | null;
  prev: HNode | null;
  head: Box | null; // pointer-to-pointer modeled as a shared box
  weight: number;
  symbol: number;
}

/** Models a `node_t**` cell — a shared, mutable reference to a node. */
interface Box {
  ref: HNode | null;
}

function newNode(): HNode {
  return {
    left: null,
    right: null,
    parent: null,
    next: null,
    prev: null,
    head: null,
    weight: 0,
    symbol: 0,
  };
}

class Huff {
  tree: HNode;
  lhead: HNode;
  loc: (HNode | null)[] = new Array(HMAX + 2).fill(null);
  private freelist: Box[] = [];

  constructor() {
    const nyt = newNode();
    nyt.symbol = NYT;
    nyt.weight = 0;
    nyt.next = nyt.prev = null;
    nyt.parent = nyt.left = nyt.right = null;
    this.tree = nyt;
    this.lhead = nyt;
    this.loc[NYT] = nyt;
  }

  private getPPNode(): Box {
    return this.freelist.pop() ?? { ref: null };
  }

  private freePPNode(box: Box): void {
    box.ref = null;
    this.freelist.push(box);
  }

  private swap(node1: HNode, node2: HNode): void {
    const par1 = node1.parent;
    const par2 = node2.parent;
    if (par1) {
      if (par1.left === node1) par1.left = node2;
      else par1.right = node2;
    } else this.tree = node2;
    if (par2) {
      if (par2.left === node2) par2.left = node1;
      else par2.right = node1;
    } else this.tree = node1;
    node1.parent = par2;
    node2.parent = par1;
  }

  private swapList(node1: HNode, node2: HNode): void {
    let par = node1.next;
    node1.next = node2.next;
    node2.next = par;

    par = node1.prev;
    node1.prev = node2.prev;
    node2.prev = par;

    if (node1.next === node1) node1.next = node2;
    if (node2.next === node2) node2.next = node1;
    if (node1.next) node1.next.prev = node1;
    if (node2.next) node2.next.prev = node2;
    if (node1.prev) node1.prev.next = node1;
    if (node2.prev) node2.prev.next = node2;
  }

  private increment(node: HNode | null): void {
    if (!node) return;

    if (node.next !== null && node.next.weight === node.weight) {
      const lnode = node.head!.ref!;
      if (lnode !== node.parent) this.swap(lnode, node);
      this.swapList(lnode, node);
    }
    if (node.prev && node.prev.weight === node.weight) {
      node.head!.ref = node.prev;
    } else {
      node.head!.ref = null;
      this.freePPNode(node.head!);
      node.head = null;
    }
    node.weight++;

    if (node.next && node.next.weight === node.weight) {
      node.head = node.next.head;
    } else {
      node.head = this.getPPNode();
      node.head.ref = node;
    }
    if (node.parent) {
      this.increment(node.parent);
      if (node.prev === node.parent) {
        this.swapList(node, node.parent);
        if (node.head!.ref === node) node.head!.ref = node.parent;
      }
    }
  }

  addRef(ch: number): void {
    if (this.loc[ch] == null) {
      const tnode = newNode();
      const tnode2 = newNode();

      tnode2.symbol = INTERNAL_NODE;
      tnode2.weight = 1;
      tnode2.next = this.lhead.next;
      if (this.lhead.next) {
        this.lhead.next.prev = tnode2;
        if (this.lhead.next.weight === 1) tnode2.head = this.lhead.next.head;
        else {
          tnode2.head = this.getPPNode();
          tnode2.head.ref = tnode2;
        }
      } else {
        tnode2.head = this.getPPNode();
        tnode2.head.ref = tnode2;
      }
      this.lhead.next = tnode2;
      tnode2.prev = this.lhead;

      tnode.symbol = ch;
      tnode.weight = 1;
      tnode.next = this.lhead.next;
      if (this.lhead.next) {
        this.lhead.next.prev = tnode;
        if (this.lhead.next.weight === 1) tnode.head = this.lhead.next.head;
        else {
          tnode.head = this.getPPNode();
          tnode.head.ref = tnode2;
        }
      } else {
        tnode.head = this.getPPNode();
        tnode.head.ref = tnode;
      }
      this.lhead.next = tnode;
      tnode.prev = this.lhead;
      tnode.left = tnode.right = null;

      if (this.lhead.parent) {
        if (this.lhead.parent.left === this.lhead) this.lhead.parent.left = tnode2;
        else this.lhead.parent.right = tnode2;
      } else {
        this.tree = tnode2;
      }

      tnode2.right = tnode;
      tnode2.left = this.lhead;
      tnode2.parent = this.lhead.parent;
      this.lhead.parent = tnode.parent = tnode2;

      this.loc[ch] = tnode;
      this.increment(tnode2.parent);
    } else {
      this.increment(this.loc[ch]);
    }
  }
}

let decompressor: Huff | null = null;

function findLowest(done: Uint8Array, data: number[]): number {
  let lowest = -1;
  let j = -1;
  for (let i = 0; i < HMAX; i++) {
    if (!done[i]) {
      if (data[i] < j || j < 0) {
        lowest = i;
        j = data[i];
      }
    }
  }
  return lowest;
}

function getDecompressor(): Huff {
  if (decompressor) return decompressor;
  const huff = new Huff();
  const done = new Uint8Array(HMAX);
  let i = findLowest(done, MSG_HDATA_COD4);
  while (i !== -1) {
    for (let j = 0; j < MSG_HDATA_COD4[i]; j++) huff.addRef(i);
    done[i] = 1;
    i = findLowest(done, MSG_HDATA_COD4);
  }
  decompressor = huff;
  return huff;
}

let bloc = 0;
function getBit(fin: Uint8Array): number {
  const t = (fin[bloc >> 3] >> (bloc & 7)) & 1;
  bloc++;
  return t;
}

/** Decompress `lenIn` bytes of `bufIn` into a new Buffer. */
export function huffmanDecompress(bufIn: Uint8Array, lenIn: number, maxOut: number): Buffer {
  const huff = getDecompressor();
  const out = Buffer.alloc(maxOut);
  const bitLen = lenIn * 8;
  if (bitLen <= 0) return out.subarray(0, 0);

  let offset = 0;
  let i = 0;
  for (; offset < bitLen && i < maxOut; i++) {
    bloc = offset;
    let node: HNode | null = huff.tree;
    while (node && node.symbol === INTERNAL_NODE) {
      node = getBit(bufIn) ? node.right : node.left;
    }
    out[i] = node ? node.symbol & 0xff : 0;
    offset = bloc;
  }
  return out.subarray(0, i);
}
