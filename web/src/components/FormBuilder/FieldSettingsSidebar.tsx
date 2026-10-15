import type { FormField, FormOption } from '../../types/form';
import { 
  FaPlus, FaTrash, FaTimes, FaCog, 
  FaListUl, FaArrowUp, FaArrowDown, FaCamera, FaShieldAlt 
} from 'react-icons/fa';

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
    const newOpts = [
      ...(field.options || []), 
      { id: Date.now().toString(), label: `Option ${(field.options?.length || 0) + 1}`, value: `opt_${Date.now()}` }
    ];
    handleChange('options', newOpts);
  };

  const removeOption = (idx: number) => {
    const newOpts = [...(field.options || [])];
    newOpts.splice(idx, 1);
    handleChange('options', newOpts);
  };

  const moveOptionUp = (idx: number) => {
    if (idx <= 0) return;
    const newOpts = [...(field.options || [])];
    const temp = newOpts[idx - 1];
    newOpts[idx - 1] = newOpts[idx];
    newOpts[idx] = temp;
    handleChange('options', newOpts);
  };

  const moveOptionDown = (idx: number) => {
    const newOpts = [...(field.options || [])];
    if (idx >= newOpts.length - 1) return;
    const temp = newOpts[idx + 1];
    newOpts[idx + 1] = newOpts[idx];
    newOpts[idx] = temp;
    handleChange('options', newOpts);
  };

  const hasOptions = ['dropdown', 'radio', 'checkbox'].includes(field.type);

  return (
    <div className="builder-inspector-panel">
      {/* Header */}
      <div className="inspector-header">
        <h3>
          <FaCog style={{ color: 'var(--primary, #0b3c7a)' }} />
          <span>Field Properties</span>
          <span className="field-type-pill" style={{ marginLeft: 4 }}>
            {field.type}
          </span>
        </h3>
        <button 
          className="btn-field-action" 
          onClick={close} 
          title="Close Inspector"
          aria-label="Close"
        >
          <FaTimes />
        </button>
      </div>

      <div className="inspector-body">
        {/* Basic Field Details */}
        <div className="inspector-group">
          <label>Display Label</label>
          <input 
            type="text" 
            value={field.label} 
            placeholder="e.g. Full Name, Email, Employee ID"
            onChange={(e) => {
              const newLabel = e.target.value;
              const isDefaultName = !field.name || field.name.startsWith('field_') || field.name.startsWith('new_') || field.name === field.type;
              if (isDefaultName && newLabel.trim().length > 0) {
                const cleanSlug = newLabel
                  .trim()
                  .replace(/[^a-zA-Z0-9 ]/g, '')
                  .split(' ')
                  .filter(Boolean)
                  .map((word, idx) => idx === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                  .join('');
                updateField(field.id, { label: newLabel, name: cleanSlug || field.name });
              } else {
                handleChange('label', newLabel);
              }
            }} 
          />
          <span className="inspector-hint">Visible title displayed to the user on the registration screen.</span>
        </div>
        
        {field.type !== 'section' && (
          <div className="inspector-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label>API Key / Field Slug</label>
              <span className="field-key-slug">Database Key</span>
            </div>
            <input 
              type="text" 
              value={field.name} 
              placeholder="e.g. fullName, employeeId, division"
              onChange={(e) => {
                const clean = e.target.value.replace(/[^a-zA-Z0-9_]/g, '');
                handleChange('name', clean);
              }} 
            />
            <span className="inspector-hint">
              Unique programmatic identifier for API submissions and DB storage.
            </span>
          </div>
        )}

        {field.type !== 'section' && (
          <div className="inspector-group">
            <label>Placeholder Text</label>
            <input 
              type="text" 
              value={field.placeholder || ''} 
              placeholder="e.g. Enter your complete legal name..."
              onChange={(e) => handleChange('placeholder', e.target.value)} 
            />
          </div>
        )}

        <div className="inspector-group">
          <label>Helper Note / Description</label>
          <input 
            type="text" 
            value={field.helperText || ''} 
            placeholder="e.g. As per your official government ID"
            onChange={(e) => handleChange('helperText', e.target.value)} 
          />
          <span className="inspector-hint">Subtle hint displayed below the input field.</span>
        </div>

        {field.type !== 'section' && (
          <>
            <div style={{ 
              background: '#f8fafc', 
              padding: '0.85rem 1rem', 
              borderRadius: '10px', 
              border: '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div>
                <strong style={{ fontSize: '0.875rem', display: 'block', color: 'var(--text-main, #0f172a)' }}>
                  Mandatory Field
                </strong>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)' }}>
                  User cannot complete registration without this
                </span>
              </div>
              <input 
                type="checkbox" 
                checked={field.required || false} 
                onChange={(e) => handleChange('required', e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
            </div>

            <div style={{ 
              background: field.unique ? '#f5f3ff' : '#f8fafc', 
              padding: '0.85rem 1rem', 
              borderRadius: '10px', 
              border: field.unique ? '1px solid #c7d2fe' : '1px solid #e2e8f0',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '0.75rem',
              transition: 'all 0.2s ease'
            }}>
              <div style={{ paddingRight: '0.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <strong style={{ fontSize: '0.875rem', display: 'block', color: field.unique ? '#4338ca' : 'var(--text-main, #0f172a)' }}>
                    Unique Identifier
                  </strong>
                  {field.unique && (
                    <span style={{ 
                      fontSize: '0.62rem', 
                      padding: '1px 6px', 
                      background: '#6366f1', 
                      color: '#ffffff', 
                      borderRadius: '999px',
                      fontWeight: 700,
                      letterSpacing: '0.03em'
                    }}>
                      UNIQUE / PRIMARY KEY
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)', display: 'block', marginTop: '2px', lineHeight: 1.3 }}>
                  Cannot be duplicated across users (e.g. Phone, Aadhar, Email, PAN). Alerts user if already exists.
                </span>
              </div>
              <input 
                type="checkbox" 
                checked={field.unique || false} 
                onChange={(e) => handleChange('unique', e.target.checked)}
                style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#6366f1' }}
              />
            </div>
          </>
        )}

        {/* Options Editor for Dropdown, Radio, Checkbox */}
        {hasOptions && (
          <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <FaListUl style={{ color: '#7c3aed' }} /> Choices & Options
              </strong>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)' }}>
                {field.options?.length || 0} option(s)
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {field.options?.map((opt, i) => (
                <div 
                  key={opt.id} 
                  style={{ 
                    display: 'flex', 
                    gap: '0.4rem', 
                    alignItems: 'center',
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '0.4rem'
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
                    <button 
                      type="button"
                      className="btn-field-action" 
                      style={{ width: '22px', height: '18px', fontSize: '0.65rem' }} 
                      disabled={i === 0}
                      onClick={() => moveOptionUp(i)}
                      title="Move option up"
                    >
                      <FaArrowUp />
                    </button>
                    <button 
                      type="button"
                      className="btn-field-action" 
                      style={{ width: '22px', height: '18px', fontSize: '0.65rem' }} 
                      disabled={i === (field.options?.length || 0) - 1}
                      onClick={() => moveOptionDown(i)}
                      title="Move option down"
                    >
                      <FaArrowDown />
                    </button>
                  </div>
                  <input 
                    style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #cbd5e1' }} 
                    type="text" 
                    value={opt.label} 
                    onChange={e => handleOptionChange(i, 'label', e.target.value)} 
                    placeholder="Option Label" 
                  />
                  <input 
                    style={{ flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.8rem', borderRadius: '6px', border: '1px solid #cbd5e1' }} 
                    type="text" 
                    value={opt.value} 
                    onChange={e => handleOptionChange(i, 'value', e.target.value)} 
                    placeholder="Stored Value" 
                  />
                  <button 
                    type="button"
                    className="btn-field-action btn-danger-action" 
                    onClick={() => removeOption(i)}
                    title="Remove option"
                    aria-label="Remove option"
                  >
                    <FaTrash />
                  </button>
                </div>
              ))}

              <button 
                type="button"
                className="section-add-btn" 
                style={{ marginTop: '0.4rem', width: '100%', justifyContent: 'center' }} 
                onClick={addOption}
              >
                <FaPlus /> Add New Choice Option
              </button>
            </div>
          </div>
        )}

        {/* Validation Settings for text-like inputs */}
        {['text', 'password', 'email', 'textarea', 'number', 'phone'].includes(field.type) && (
          <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1.25rem' }}>
            <strong style={{ fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
              <FaShieldAlt style={{ color: '#0284c7' }} /> Validation Rules
            </strong>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div className="inspector-group">
                <label>Min Length</label>
                <input 
                  type="number" 
                  value={field.validation?.minLength ?? ''} 
                  placeholder="e.g. 3"
                  onChange={e => updateValidation('minLength', e.target.value ? parseInt(e.target.value, 10) : undefined)} 
                />
              </div>
              <div className="inspector-group">
                <label>Max Length</label>
                <input 
                  type="number" 
                  value={field.validation?.maxLength ?? ''} 
                  placeholder="e.g. 50"
                  onChange={e => updateValidation('maxLength', e.target.value ? parseInt(e.target.value, 10) : undefined)} 
                />
              </div>
            </div>

            <div className="inspector-group" style={{ marginTop: '0.75rem' }}>
              <label>Regex Regex Pattern</label>
              <input 
                type="text" 
                value={field.validation?.pattern || ''} 
                onChange={e => updateValidation('pattern', e.target.value)} 
                placeholder="e.g. ^[A-Z0-9]{6,12}$" 
              />
              <span className="inspector-hint">Custom regular expression validator.</span>
            </div>

            {field.type === 'password' && (
              <div style={{ 
                background: '#f8fafc', 
                padding: '0.75rem', 
                borderRadius: '8px', 
                border: '1px solid #e2e8f0',
                marginTop: '0.75rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem'
              }}>
                <input 
                  type="checkbox" 
                  checked={field.validation?.passwordRules || false} 
                  onChange={(e) => updateValidation('passwordRules', e.target.checked)} 
                  id="pwd-enforce"
                />
                <label htmlFor="pwd-enforce" style={{ fontSize: '0.825rem', fontWeight: 600, cursor: 'pointer' }}>
                  Enforce strong security (Upper, Lower, Number, Symbol)
                </label>
              </div>
            )}

            <div className="inspector-group" style={{ marginTop: '0.75rem' }}>
              <label>Custom Error Message</label>
              <input 
                type="text" 
                value={field.validation?.customError || ''} 
                onChange={e => updateValidation('customError', e.target.value)} 
                placeholder="e.g. Invalid Employee Code format" 
              />
            </div>
          </div>
        )}

        {/* Image / Media Settings */}
        {field.type === 'image' && (
          <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1.25rem' }}>
            <strong style={{ fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
              <FaCamera style={{ color: '#c026d3' }} /> Camera & Upload Settings
            </strong>
            
            <div className="inspector-group">
              <label>Allowed Source</label>
              <select 
                value={field.imageSettings?.source || 'both'} 
                onChange={e => handleChange('imageSettings', { ...field.imageSettings, source: e.target.value })}
              >
                <option value="both">Live Camera & Gallery Uploads</option>
                <option value="camera">Live Camera Only (Prevents File Tampering)</option>
                <option value="gallery">Photo Gallery Only</option>
              </select>
              <span className="inspector-hint">
                Recommended: 'Live Camera Only' for gate security badges & evidence.
              </span>
            </div>

            <div className="inspector-group" style={{ marginTop: '0.75rem' }}>
              <label>Max Allowed File Size (MB)</label>
              <input 
                type="number" 
                value={field.imageSettings?.maxSizeMB || 5} 
                onChange={e => handleChange('imageSettings', { ...field.imageSettings, maxSizeMB: parseFloat(e.target.value) || 5 })} 
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
