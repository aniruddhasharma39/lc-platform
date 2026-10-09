import type { FormField, FormOption } from '../../types/form';
import { FaPlus, FaTrash, FaGripVertical } from 'react-icons/fa';

type Props = {
  field: FormField;
  updateField: (id: string, updates: Partial<FormField>) => void;
  close: () => void;
};

export default function FieldSettingsSidebar({ field, updateField, close }: Props) {
  const handleChange = (key: keyof FormField, value: any) => {
    updateField(field.id, { [key]: value });
  };

  const updateValidation = (key: string, value: any) => {
    updateField(field.id, {
      validation: { ...field.validation, [key]: value }
    });
  };

  const handleOptionChange = (idx: number, optKey: keyof FormOption, val: string) => {
    const newOpts = [...(field.options || [])];
    newOpts[idx] = { ...newOpts[idx], [optKey]: val };
    handleChange('options', newOpts);
  };

  const addOption = () => {
    const newOpts = [...(field.options || []), { id: Date.now().toString(), label: `Option ${(field.options?.length || 0) + 1}`, value: `opt_${Date.now()}` }];
    handleChange('options', newOpts);
  };

  const removeOption = (idx: number) => {
    const newOpts = [...(field.options || [])];
    newOpts.splice(idx, 1);
    handleChange('options', newOpts);
  };

  const hasOptions = ['dropdown', 'radio', 'checkbox'].includes(field.type);

  return (
    <div className="card h-full" style={{ display: 'flex', flexDirection: 'column', padding: 0, width: 350, borderLeft: '1px solid var(--border)', overflowY: 'auto' }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Field Settings</h3>
        <button className="icon-btn" onClick={close}>X</button>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Core Settings */}
        <div>
          <label className="text-sm fw-bold">Label</label>
          <input type="text" value={field.label} onChange={(e) => handleChange('label', e.target.value)} />
        </div>
        
        {field.type !== 'section' && (
          <div>
            <label className="text-sm fw-bold">Field Key (API Name)</label>
            <input type="text" value={field.name} onChange={(e) => handleChange('name', e.target.value)} />
          </div>
        )}

        {field.type !== 'section' && (
          <div>
            <label className="text-sm fw-bold">Placeholder</label>
            <input type="text" value={field.placeholder || ''} onChange={(e) => handleChange('placeholder', e.target.value)} />
          </div>
        )}

        <div>
          <label className="text-sm fw-bold">Helper Note</label>
          <input type="text" value={field.helperText || ''} onChange={(e) => handleChange('helperText', e.target.value)} />
        </div>

        {field.type !== 'section' && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={field.required || false} onChange={(e) => handleChange('required', e.target.checked)} />
            Required Field
          </label>
        )}

        {/* Options Editor */}
        {hasOptions && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <h4 style={{ margin: '0 0 8px 0' }}>Options</h4>
            <div className="flex-col gap-2">
              {field.options?.map((opt, i) => (
                <div key={opt.id} className="flex gap-2 items-center">
                  <FaGripVertical style={{ cursor: 'grab', color: 'var(--muted)' }} />
                  <input style={{ flex: 1 }} type="text" value={opt.label} onChange={e => handleOptionChange(i, 'label', e.target.value)} placeholder="Label" />
                  <input style={{ flex: 1 }} type="text" value={opt.value} onChange={e => handleOptionChange(i, 'value', e.target.value)} placeholder="Value" />
                  <button className="icon-btn danger" onClick={() => removeOption(i)}><FaTrash /></button>
                </div>
              ))}
              <button className="secondary mt-2" onClick={addOption}><FaPlus /> Add Option</button>
            </div>
          </div>
        )}

        {/* Validation Settings */}
        {['text', 'password', 'email', 'textarea', 'number', 'phone'].includes(field.type) && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <h4 style={{ margin: '0 0 8px 0' }}>Validation</h4>
            
            <div className="flex gap-2 mt-2">
              <div style={{ flex: 1 }}>
                <label className="text-sm">Min Length</label>
                <input type="number" value={field.validation?.minLength || ''} onChange={e => updateValidation('minLength', parseInt(e.target.value) || undefined)} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="text-sm">Max Length</label>
                <input type="number" value={field.validation?.maxLength || ''} onChange={e => updateValidation('maxLength', parseInt(e.target.value) || undefined)} />
              </div>
            </div>

            <div className="mt-2">
              <label className="text-sm">Regex Pattern</label>
              <input type="text" value={field.validation?.pattern || ''} onChange={e => updateValidation('pattern', e.target.value)} placeholder="e.g. ^[a-zA-Z]+$" />
            </div>

            {field.type === 'password' && (
              <label className="flex items-center gap-2 mt-2">
                <input type="checkbox" checked={field.validation?.passwordRules || false} onChange={(e) => updateValidation('passwordRules', e.target.checked)} />
                Enforce Strong Password Rules
              </label>
            )}

            <div className="mt-2">
              <label className="text-sm">Custom Error Message</label>
              <input type="text" value={field.validation?.customError || ''} onChange={e => updateValidation('customError', e.target.value)} placeholder="Message when validation fails" />
            </div>
          </div>
        )}

        {/* Image Settings */}
        {field.type === 'image' && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <h4 style={{ margin: '0 0 8px 0' }}>Image Settings</h4>
            
            <label className="text-sm fw-bold">Source</label>
            <select 
              value={field.imageSettings?.source || 'both'} 
              onChange={e => handleChange('imageSettings', { ...field.imageSettings, source: e.target.value })}
            >
              <option value="both">Camera & Gallery</option>
              <option value="camera">Camera Only (Reduces Tampering)</option>
              <option value="gallery">Gallery Only</option>
            </select>
            <span className="text-sm text-muted mt-1 block">Note: Camera only reduces tampering but is not a 100% guarantee on all devices.</span>

            <div className="mt-4">
              <label className="text-sm fw-bold">Max Size (MB)</label>
              <input type="number" value={field.imageSettings?.maxSizeMB || 5} onChange={e => handleChange('imageSettings', { ...field.imageSettings, maxSizeMB: parseFloat(e.target.value) })} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
