/**
 * Static catalogue: resource types and injury archetypes.
 * Values are illustrative placeholders, flagged as such in the UI.
 */

export type ResourceType = 'bed' | 'blood_unit' | 'o2' | 'vent' | 'or_table';

export interface ResourceSpec {
  type: ResourceType;
  label: string;
  unit: string;
  /** Consumables are used up; reusables are held and released. */
  kind: 'consumable' | 'reusable';
}

export const RESOURCES: Record<ResourceType, ResourceSpec> = {
  bed: { type: 'bed', label: 'Beds', unit: 'beds', kind: 'reusable' },
  blood_unit: { type: 'blood_unit', label: 'Blood', unit: 'units', kind: 'consumable' },
  o2: { type: 'o2', label: 'Oxygen', unit: 'cyl', kind: 'consumable' },
  vent: { type: 'vent', label: 'Ventilators', unit: 'vents', kind: 'reusable' },
  or_table: { type: 'or_table', label: 'OR tables', unit: 'tables', kind: 'reusable' },
};

export const RESOURCE_ORDER: ResourceType[] = ['blood_unit', 'o2', 'vent', 'or_table', 'bed'];

/** Destination capabilities an evacuation slot can offer. */
export type Capability = 'trauma_surgery' | 'burn' | 'neuro' | 'general';

export const CAPABILITY_LABEL: Record<Capability, string> = {
  trauma_surgery: 'Level I trauma / surgery',
  burn: 'Burn centre',
  neuro: 'Neurosurgery',
  general: 'General hospital',
};

export interface InjurySpec {
  label: string;
  capability: Capability;
  needsSurgery: boolean;
}

export const INJURIES: Record<string, InjurySpec> = {
  blast_extremity: { label: 'Blast extremity', capability: 'trauma_surgery', needsSurgery: true },
  penetrating_torso: { label: 'Penetrating torso', capability: 'trauma_surgery', needsSurgery: true },
  crush: { label: 'Crush injury', capability: 'trauma_surgery', needsSurgery: false },
  burns: { label: 'Burns', capability: 'burn', needsSurgery: false },
  head_injury: { label: 'Head injury', capability: 'neuro', needsSurgery: false },
  inhalation: { label: 'Smoke inhalation', capability: 'general', needsSurgery: false },
  fracture: { label: 'Closed fracture', capability: 'general', needsSurgery: false },
  minor_laceration: { label: 'Minor laceration', capability: 'general', needsSurgery: false },
};

export function injurySpec(injuryType: string): InjurySpec {
  return INJURIES[injuryType] ?? { label: injuryType, capability: 'general', needsSurgery: false };
}
