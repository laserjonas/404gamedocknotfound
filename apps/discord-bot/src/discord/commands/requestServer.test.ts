import { describe, expect, it } from 'vitest';
import { modalFieldsFor } from './requestServer.js';
import type { TemplateVariableDto } from '@gamedock/shared';

function variable(overrides: Partial<TemplateVariableDto> = {}): TemplateVariableDto {
  return { key: 'KEY', label: 'Label', default: '', required: true, ...overrides };
}

describe('modalFieldsFor', () => {
  it('only includes required variables', () => {
    const fields = modalFieldsFor({
      variables: [
        variable({ key: 'A', required: true }),
        variable({ key: 'B', required: false }),
        variable({ key: 'C', required: true }),
      ],
    });
    expect(fields.map((f) => f.key)).toEqual(['A', 'C']);
  });

  it('caps at 5 fields, in declaration order, even if more are required', () => {
    const variables = Array.from({ length: 7 }, (_, i) =>
      variable({ key: `V${i}`, required: true }),
    );
    const fields = modalFieldsFor({ variables });
    expect(fields).toHaveLength(5);
    expect(fields.map((f) => f.key)).toEqual(['V0', 'V1', 'V2', 'V3', 'V4']);
  });

  it('returns an empty array when nothing is required', () => {
    const fields = modalFieldsFor({
      variables: [variable({ required: false }), variable({ required: false })],
    });
    expect(fields).toEqual([]);
  });
});
