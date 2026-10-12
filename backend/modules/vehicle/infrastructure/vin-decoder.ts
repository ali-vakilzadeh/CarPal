// VIN decoder port (40 vehicles.vin_decode, Plan WP5 "optional pluggable VIN
// decode"). Third-party output is validated like client input before use
// (SEC-IN-10): only known VehicleWrite fields with valid values become
// suggestions. Lite mode decodes locally what the VIN itself encodes (the
// model year, position 10); full mode needs a regional decoder adapter and
// answers 503 UNAVAILABLE(decoder) until one is configured.
import { ApiError } from '#libs/contract/index.js';
import { maxModelYear } from '../domain/rules.js';
import { modelYear } from '../domain/vin.js';

/** Fields a decoder may suggest (a subset of 40 VehicleWrite). */
export interface VinSuggestion {
  year?: number;
  brand_node_id?: string;
  model_node_id?: string;
  series_node_id?: string;
  engine_type_node_id?: string;
  fuel_type_node_id?: string;
  transmission?: 'manual' | 'automatic' | 'cvt' | 'dct' | 'other';
  drivetrain?: 'fwd' | 'rwd' | 'awd' | '4wd';
  body_style?: 'sedan' | 'hatchback' | 'wagon' | 'coupe' | 'convertible' | 'suv' | 'pickup' | 'van' | 'minivan' | 'other';
}

export interface VinDecoding {
  status: 'decoded' | 'partial' | 'failed';
  suggested: VinSuggestion;
  source: string;
}

export abstract class VinDecoder {
  /** Decodes a validated VIN; throws 503 UNAVAILABLE(decoder) when the decoder cannot be reached. */
  abstract decode(vin: string): Promise<VinDecoding>;
}

/** Lite decoder: the model year from position 10; brand and model need a real decoder. */
export class LocalVinDecoder extends VinDecoder {
  async decode(vin: string): Promise<VinDecoding> {
    const now = new Date();
    const year = modelYear(vin, now.getUTCFullYear());
    if (year === null || year < 1950 || year > maxModelYear(now)) return { status: 'failed', suggested: {}, source: 'carpal-local' };
    return { status: 'partial', suggested: { year }, source: 'carpal-local' };
  }
}

export class UnconfiguredVinDecoder extends VinDecoder {
  async decode(): Promise<VinDecoding> {
    throw new ApiError('UNAVAILABLE', { detail: 'decoder' });
  }
}
