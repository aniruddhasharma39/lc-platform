export type FieldType = 'text' | 'number' | 'email' | 'phone' | 'password' | 'textarea' | 'dropdown' | 'radio' | 'checkbox' | 'date' | 'image' | 'section';

export interface FormValidation {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  passwordRules?: boolean;
  customError?: string;
}

export interface ImageSettings {
  source: 'camera' | 'gallery' | 'both';
  acceptedTypes?: string[];
  maxSizeMB?: number;
}

export interface FormOption {
  id: string;
  label: string;
  value: string;
}

export interface FormField {
  id: string;
  type: FieldType;
  name: string; // key in the json payload
  label: string;
  placeholder?: string;
  helperText?: string;
  required?: boolean;
  
  // Specific to select/radio/checkbox
  options?: FormOption[];
  
  // Specific to inputs
  validation?: FormValidation;
  
  // Specific to images
  imageSettings?: ImageSettings;
  
  // Specific to sections
  children?: FormField[];
}

export interface FormSchema {
  fields: FormField[];
  allowRoles?: boolean;
  allowedRoles?: string[];
}
