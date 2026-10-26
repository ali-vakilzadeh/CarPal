// BA-29: VIN clean-up and the check-digit rule (North American and Chinese VINs only).
import { describe, expect, it } from 'vitest';
import { cleanVin, vinProblem } from './vin';

describe('VIN input', () => {
  it('cleans pasted VINs like the backend', () => {
    expect(cleanVin(' wbaph5c55ba274521 ')).toBe('WBAPH5C55BA274521');
    expect(cleanVin('WBA-PH5 C55.BA_274521')).toBe('WBAPH5C55BA274521');
    expect(cleanVin('WBAPH5C۵۵BA۲۷۴۵۲۱')).toBe('WBAPH5C55BA274521');
  });

  it('accepts an empty VIN and a European VIN without a check digit', () => {
    expect(vinProblem('')).toBeNull();
    expect(vinProblem('WBAPH5C55BA274521')).toBeNull();
  });

  it('names the problem', () => {
    expect(vinProblem('WBAPH5C55BA27')).toBe('length');
    expect(vinProblem('WBAPH5C55BA27452I')).toBe('letters');
    expect(vinProblem('WBAPH5C55BA27452!')).toBe('invalid');
  });

  it('checks the ISO 3779 check digit for WMI 1-5 and L only', () => {
    expect(vinProblem('1HGCM82633A004352')).toBeNull();
    expect(vinProblem('1HGCM82693A004352')).toBe('invalid');
    expect(vinProblem('LVSHFFAL0EF000001')).toBe('invalid');
    expect(vinProblem('JHGCM82693A004352')).toBeNull();
  });
});
