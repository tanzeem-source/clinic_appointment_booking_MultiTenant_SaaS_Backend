// The single source of truth for doctor specializations. Validation, the
// search filters and the specializations endpoint all read this list, so
// every doctor's value is one of these exact strings. If you edit it, keep the
// SQL migration list in step.
export const SPECIALIZATIONS = [
  "General Physician",
  "Pediatrician",
  "Gynecologist",
  "Dermatologist",
  "Cardiologist",
  "Orthopedist",
  "Dentist",
  "ENT Specialist",
  "Ophthalmologist",
  "Neurologist",
  "Psychiatrist",
  "Urologist",
  "Gastroenterologist",
  "Endocrinologist",
  "Pulmonologist",
  "Nephrologist",
  "Oncologist",
  "General Surgeon",
  "Physiotherapist",
  "Diabetologist",
] as const;

export type Specialization = (typeof SPECIALIZATIONS)[number];
