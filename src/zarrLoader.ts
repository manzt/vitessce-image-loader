import { ZarrArray, TypedArray } from 'zarr';
import { RawArray } from 'zarr/dist/types/rawArray';
import {
  Dimension,
  ImageLoader,
  TileIndex,
  RasterIndex,
  DimensionSelection,
  TileData,
  RasterData,
} from './types';
import { guessRgb, normalizeChannelSelection, ensureDecreasing, range } from './utils';
import { DtypeString } from 'zarr/dist/types/types';

export default class ZarrLoader implements ImageLoader {
  public type: string;
  public isRgb: boolean;
  public scale: number;
  public translate: number[];
  public dimensions?: Dimension[];
  public dtype: DtypeString;
  public tileSize: number;
  public numLevels: number;

  private _xIndex: number;
  private _yIndex: number;
  private _data: ZarrArray | ZarrArray[];
  private _channelSelections: number[][];

  constructor(
    data: ZarrArray | ZarrArray[],
    dimensions?: Dimension[],
    isRgb?: boolean,
    scale = 1,
    translate = [0, 0],
  ) {
    let base;
    if (Array.isArray(data)) {
      const allDecreasing = ensureDecreasing(data.map(d => d.shape));
      if (!allDecreasing) {
        throw Error('Arrays provided must be decreasing in shape');
      }
      [base] = data;
      this.numLevels = data.length;
    } else {
      base = data;
      this.numLevels = 1;
    }
    // Public attributes
    this.type = 'zarr';
    this.scale = scale;
    this.translate = translate;
    this.isRgb = isRgb ? isRgb : guessRgb(base.shape);
    if (dimensions && dimensions.length !== base.shape.length) {
      // If provided, make sure that number of labeled dims corresponds to number of arr dims
      throw Error(
        `Dimension labels ${JSON.stringify(dimensions)} does not match image with shape ${
          base.shape
        }`,
      );
    }
    this.dimensions = dimensions;

    // Private attributes
    this._data = data;
    if (this.isRgb) {
      this._xIndex = base.shape.length - 2;
      this._yIndex = base.shape.length - 3;
    } else {
      this._xIndex = base.shape.length - 1;
      this._yIndex = base.shape.length - 2;
    }
    this._channelSelections = [Array(base.shape.length).fill(0)];

    const { dtype, chunks } = base;
    this.dtype = dtype;
    // TODO: check if x and y chunk sizes are different?
    this.tileSize = chunks[this._xIndex];
  }

  public get isPyramid(): boolean {
    return Array.isArray(this._data);
  }

  public get base(): ZarrArray {
    return this.isPyramid ? (this._data as ZarrArray[])[0] : (this._data as ZarrArray);
  }

  public get channelSelections(): number[][] {
    return this._channelSelections;
  }

  public async getTile({ x, y, z }: TileIndex): Promise<TileData> {
    const source = this._getSource(z);
    const dataRequests = this._channelSelections.map(async key => {
      const chunkKey = [...key];
      chunkKey[this._yIndex] = y;
      chunkKey[this._xIndex] = x;
      const { data } = await source.getRawChunk(chunkKey);
      return data;
    });
    const data = await Promise.all(dataRequests);
    if (this._isUnchunkedMultiChannel) {
      // data is an array of length 1
      return this._decodeChannels(data[0]);
    }
    return data;
  }

  public async getRaster({ z }: RasterIndex = { z: undefined }): Promise<RasterData> {
    const source = this._getSource(z);
    const dataRequests = this._channelSelections.map(async (key: (number | null)[]) => {
      const chunkKey = [...key];
      chunkKey[this._yIndex] = null;
      chunkKey[this._xIndex] = null;
      if (this.isRgb) {
        chunkKey[chunkKey.length - 1] = null;
      } else if (this._isUnchunkedMultiChannel) {
        chunkKey[this._yIndex - 1] = null;
      }
      const { data } = (await source.getRaw(chunkKey)) as RawArray;
      return data;
    });
    const data = await Promise.all(dataRequests);
    const { shape } = source;
    const width = shape[this._xIndex];
    const height = shape[this._yIndex];
    if (this._isUnchunkedMultiChannel) {
      return { data: this._decodeChannels(data[0]), width, height };
    }
    return { data, width, height };
  }

  public onTileError(err: Error): void {
    // Handle zarr-specific tile Errors
    // Will check with `err instanceof BoundCheckError` when merged
    // https://github.com/gzuidhof/zarr.js/issues/47
    if (!err.message.includes('RangeError')) {
      // Rethrow error if something other than tile being requested is out of bounds.
      throw err;
    }
  }

  public setChannelSelections(
    channelSelections: (DimensionSelection | number)[][] | (DimensionSelection | number)[],
  ): void {
    // Wrap channel selection in array if only one is provided
    channelSelections = (Array.isArray(channelSelections[0])
      ? channelSelections
      : [channelSelections]) as (DimensionSelection | number)[][];

    const nextChannelSelections: number[][] = channelSelections.map(sel => {
      if (!this.dimensions) {
        const isDirectSelection = sel.every(d => typeof d === 'number');
        if (isDirectSelection) {
          return sel as number[];
        } else {
          throw Error(
            `Cannot used named selection '${sel}' to index image with specified dimensions.`,
          );
        }
      }
      return normalizeChannelSelection(this.dimensions, sel as DimensionSelection[]);
    });

    if ((this.isRgb || this._isUnchunkedMultiChannel) && nextChannelSelections.length > 1) {
      throw Error(
        `Cannot specify multiple channel selections for RGB/A image or
        multichannel image with chunk sizes greater than one.`,
      );
    }

    // Validate selections
    for (const sel of nextChannelSelections) {
      if (sel.length !== this.base.shape.length) {
        throw Error(
          `Normalized selections ${nextChannelSelections} do not
          correspond to image with shape ${this.base.shape}`,
        );
      }
      if (sel.some((key, i) => key !== 0 && this.base.chunks[i] > 1)) {
        throw Error('Cannot set selection for dimension with chunk size greater than one.');
      }
    }

    this._channelSelections = nextChannelSelections;
  }

  private get _isUnchunkedMultiChannel(): boolean {
    return this._yIndex - 1 >= 0 ? this.base.chunks[this._yIndex - 1] > 1 : false;
  }

  private _getSource(z?: number): ZarrArray {
    return typeof z === 'number' && this.isPyramid
      ? (this._data as ZarrArray[])[z]
      : (this._data as ZarrArray);
  }

  private _decodeChannels(chunkData: TypedArray): TypedArray[] {
    // Used for multichannel images where channels are in same chunk.
    // Separates single TypedArray into multiple channel views.
    const channelChunkSize = this.base.chunks[this._yIndex - 1];
    const offset = chunkData.length / channelChunkSize;
    const tileData = range(channelChunkSize).map(i =>
      chunkData.subarray(offset * i, offset * i + offset),
    );
    return tileData;
  }
}
