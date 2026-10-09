import { useEffect, useState } from 'react';
import type { FormField, FormSchema } from '../types/form';
import FieldSettingsSidebar from '../components/FormBuilder/FieldSettingsSidebar';
import FormRenderer from '../components/FormBuilder/FormRenderer';
import { removeNode, insertBefore, appendToSection } from '../utils/tree';
import { FaGripVertical, FaTrash, FaFolder, FaFont, FaHashtag, FaEnvelope, FaPhone, FaLock, FaCheckSquare, FaCircle, FaCaretSquareDown, FaCalendar, FaImage, FaPlus, FaMobileAlt, FaDesktop, FaExclamationTriangle } from 'react-icons/fa';
import { API_URL } from '../config';

export default function RegistrationBuilder() {
  const [forms, setForms] = useState<any[]>([]);
  const [editingForm, setEditingForm] = useState<any>(null);
  
  // Active Schema
  const [fields, setFields] = useState<FormField[]>([]);
  const [allowRoles, setAllowRoles] = useState(false);
  
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [builderErrors, setBuilderErrors] = useState<string[]>([]);
  
  // App state
  const [showPreview, setShowPreview] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<'web' | 'mobile'>('web');
  const [systemRoles, setSystemRoles] = useState<any[]>([]);

  // Drag state

  const fetchForms = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/registration-forms`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setForms(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchRoles = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/roles`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      setSystemRoles(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchForms();
    fetchRoles();
  }, []);

  const createForm = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/registration-forms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ name: 'New Registration Form', schema: JSON.stringify({ fields: [], allowRoles: true }) })
      });
      const data = await res.json();
      setForms([data, ...forms]);
    } catch (err) {
      console.error(err);
    }
  };

  const deleteForm = async (id: number) => {
    if (!confirm('Are you sure you want to delete this form?')) return;
    try {
      const res = await fetch(`${API_URL}/api/v1/registration-forms/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        setForms(forms.filter(f => f.id !== id));
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to delete form');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const openForm = (f: any) => {
    setEditingForm(f);
    try {
      const parsed = JSON.parse(f.schema) as FormSchema;
      setFields(parsed.fields || []);
      setAllowRoles(parsed.allowRoles ?? true);
    } catch {
      setFields([]);
      setAllowRoles(true);
    }
    setActiveFieldId(null);
    setBuilderErrors([]);
  };

  const closeForm = () => {
    if (confirm('Leave without saving? Any unsaved changes will be lost.')) {
      setEditingForm(null);
      setFields([]);
    }
  };

  const validateBuilder = (): string[] => {
    const errors: string[] = [];
    const keys = new Set<string>();

    const checkField = (f: FormField) => {
      if (!f.label || f.label.trim() === '') errors.push(`Field/Section missing label (ID: ${f.id})`);
      if (f.type !== 'section') {
        if (!f.name || f.name.trim() === '') errors.push(`Field '${f.label}' is missing an API Key`);
        if (keys.has(f.name)) errors.push(`Duplicate API Key found: '${f.name}'`);
        keys.add(f.name);
      }
      if (['dropdown', 'radio', 'checkbox'].includes(f.type)) {
        if (!f.options || f.options.length === 0) errors.push(`Field '${f.label}' must have at least one option.`);
        const optValues = new Set<string>();
        f.options?.forEach(o => {
          if (optValues.has(o.value)) errors.push(`Field '${f.label}' has duplicate option value: '${o.value}'`);
          optValues.add(o.value);
        });
      }
      if (f.validation) {
        if (f.validation.minLength && f.validation.maxLength && f.validation.minLength > f.validation.maxLength) {
          errors.push(`Field '${f.label}' has contradictory validation (min > max)`);
        }
      }
      if (f.children) {
        f.children.forEach(checkField);
      }
    };

    fields.forEach(checkField);
    return errors;
  };

  const saveForm = async () => {
    if (!editingForm) return;
    
    // Warn but allow saving draft
    const errors = validateBuilder();
    if (errors.length > 0) {
      if (!confirm(`Warning: Your form has ${errors.length} validation errors. Save draft anyway?`)) return;
    }

    try {
      const payload: FormSchema = { fields, allowRoles };
      const res = await fetch(`${API_URL}/api/v1/registration-forms/${editingForm.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ name: editingForm.name, schema: JSON.stringify(payload) })
      });
      if (res.ok) {
        const updated = await res.json();
        setEditingForm(updated);
        alert('Draft saved successfully!');
        fetchForms();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const publishForm = async () => {
    if (!editingForm) return;
    const errors = validateBuilder();
    if (errors.length > 0) {
      setBuilderErrors(errors);
      alert('Cannot publish. Please fix validation errors first.');
      return;
    }

    if (confirm('Are you sure you want to publish this form? This will become the live registration form for all new users.')) {
      try {
        const payload: FormSchema = { fields, allowRoles };
        
        // Save first
        await fetch(`${API_URL}/api/v1/registration-forms/${editingForm.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({ name: editingForm.name, schema: JSON.stringify(payload) })
        });

        // Publish
        const res = await fetch(`${API_URL}/api/v1/registration-forms/${editingForm.id}/publish`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        });
        if (res.ok) {
          alert('Form published successfully!');
          fetchForms();
          setEditingForm(null);
        }
      } catch (err) {
        console.error(err);
      }
    }
  };

  // --- Drag and Drop Handlers ---
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.stopPropagation();
  };

  const handleDropOnField = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === targetId) return;

    setFields(prev => {
      let { newList, removed } = removeNode(prev, sourceId);
      if (removed) {
        return insertBefore(newList, targetId, removed);
      }
      return prev;
    });
  };

  const handleDropOnSection = (e: React.DragEvent, sectionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const sourceId = e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === sectionId) return;

    setFields(prev => {
      let { newList, removed } = removeNode(prev, sourceId);
      if (removed) {
        return appendToSection(newList, sectionId, removed);
      }
      return prev;
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // --- Field Tree Updates ---
  const mapFields = (list: FormField[], id: string, updater: (f: FormField) => FormField): FormField[] => {
    return list.map(f => {
      if (f.id === id) return updater(f);
      if (f.children) return { ...f, children: mapFields(f.children, id, updater) };
      return f;
    });
  };

  const removeField = (list: FormField[], id: string): FormField[] => {
    return list.filter(f => f.id !== id).map(f => {
      if (f.children) return { ...f, children: removeField(f.children, id) };
      return f;
    });
  };

  const updateField = (id: string, updates: Partial<FormField>) => {
    setFields(prev => mapFields(prev, id, (f) => ({ ...f, ...updates })));
  };

  const handleDeleteField = (id: string) => {
    if (confirm('Are you sure you want to delete this field? If it is a section, all nested fields will also be deleted.')) {
      setFields(prev => removeField(prev, id));
      if (activeFieldId === id) setActiveFieldId(null);
    }
  };

  const handleAddField = (type: FormField['type']) => {
    const newField: FormField = {
      id: Date.now().toString(),
      type,
      name: type === 'section' ? '' : `field_${Date.now()}`,
      label: type === 'section' ? 'New Section' : 'New Field',
      children: type === 'section' ? [] : undefined,
      options: ['dropdown', 'radio', 'checkbox'].includes(type) ? [
        { id: Date.now().toString() + '_1', label: 'Option 1', value: 'opt_1' }
      ] : undefined
    };
    setFields([...fields, newField]);
    setActiveFieldId(newField.id);
  };

  const renderField = (field: FormField) => {
    const isActive = activeFieldId === field.id;
    return (
      <div 
        key={field.id}
        draggable
        onDragStart={(e) => handleDragStart(e, field.id)}
        onDragOver={handleDragOver}
        onDrop={(e) => handleDropOnField(e, field.id)}
        style={{ 
          border: isActive ? '2px solid var(--primary)' : '1px solid var(--border)', 
          padding: 16, 
          marginBottom: 8, 
          borderRadius: 8, 
          backgroundColor: field.type === 'section' ? 'var(--background)' : '#fff',
          cursor: 'pointer'
        }}
        onClick={(e) => { e.stopPropagation(); setActiveFieldId(field.id); }}
      >
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div style={{ cursor: 'grab', color: 'var(--muted)', padding: 8 }}><FaGripVertical /></div>
            <strong>{field.label || 'Untitled'}</strong>
            <span className="badge" style={{ backgroundColor: 'var(--border)', color: '#333' }}>{field.type}</span>
            {field.required && <span className="text-danger text-sm">* Req</span>}
          </div>
          <div className="flex gap-2">
            <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); handleDeleteField(field.id); }}><FaTrash /></button>
          </div>
        </div>
        
        {field.type === 'section' && (
          <div 
            style={{ paddingLeft: 24, paddingTop: 16, borderLeft: '2px dashed var(--border)', marginTop: 16, minHeight: 60 }}
            onDrop={(e) => handleDropOnSection(e, field.id)}
            onDragOver={handleDragOver}
          >
            {field.children?.map(renderField)}
            {(!field.children || field.children.length === 0) && (
              <div className="text-muted text-sm mt-2 p-4 text-center border-dashed border-2 rounded">Drop fields here to add to section</div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (editingForm) {
    const activeField = activeFieldId ? (() => {
      const search = (list: FormField[]): FormField | null => {
        for(const f of list) {
          if (f.id === activeFieldId) return f;
          if (f.children) {
            const found = search(f.children);
            if (found) return found;
          }
        }
        return null;
      };
      return search(fields);
    })() : null;

    return (
      <div className="flex-col h-full">
        <div className="card flex justify-between items-center" style={{ borderRadius: 0, borderBottom: '1px solid var(--border)', padding: '16px 24px' }}>
          <div>
            <h2 style={{ margin: 0 }}>
              <input 
                type="text" 
                value={editingForm.name} 
                onChange={e => setEditingForm({...editingForm, name: e.target.value})} 
                style={{ fontSize: '1.5rem', fontWeight: 'bold', border: 'none', outline: 'none', background: 'transparent' }}
              />
            </h2>
            <div className="flex gap-4 mt-2">
              <span className={`badge ${editingForm.status.toLowerCase()}`}>{editingForm.status}</span>
              <span className="text-muted">Version {editingForm.version}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="secondary outline" onClick={closeForm}>Cancel</button>
            <button className="secondary" onClick={() => { setBuilderErrors(validateBuilder()); setShowPreview(true); }}>Preview</button>
            <button className="primary" onClick={saveForm}>Save Draft</button>
            <button className="primary outline" onClick={publishForm}>Publish Live</button>
          </div>
        </div>

        {builderErrors.length > 0 && (
          <div style={{ padding: '16px 24px', backgroundColor: 'var(--danger)', color: '#fff' }}>
            <div className="flex items-center gap-2 mb-2"><FaExclamationTriangle /> <strong>Validation Errors</strong></div>
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {builderErrors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        <div className="flex" style={{ flex: 1, overflow: 'hidden' }}>
          {/* Add Fields Sidebar */}
          <div className="card h-full" style={{ width: 250, padding: 16, borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
            <h3 className="mb-4">Add Field</h3>
            <div className="flex-col gap-2">
              {[
                { type: 'text', label: 'Short Text', icon: FaFont },
                { type: 'textarea', label: 'Long Text', icon: FaFont },
                { type: 'number', label: 'Number', icon: FaHashtag },
                { type: 'email', label: 'Email', icon: FaEnvelope },
                { type: 'phone', label: 'Phone', icon: FaPhone },
                { type: 'password', label: 'Password', icon: FaLock },
                { type: 'dropdown', label: 'Dropdown', icon: FaCaretSquareDown },
                { type: 'radio', label: 'Single Choice', icon: FaCircle },
                { type: 'checkbox', label: 'Multiple Choice', icon: FaCheckSquare },
                { type: 'date', label: 'Date Picker', icon: FaCalendar },
                { type: 'image', label: 'Image Upload', icon: FaImage },
                { type: 'section', label: 'Section Container', icon: FaFolder },
              ].map(f => (
                <button 
                  key={f.type}
                  className="secondary outline text-left flex gap-2 items-center" 
                  style={{ width: '100%', justifyContent: 'flex-start' }}
                  onClick={() => handleAddField(f.type as any)}
                >
                  <f.icon /> {f.label}
                </button>
              ))}
            </div>

            <h3 className="mt-8 mb-4">Form Settings</h3>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={allowRoles} onChange={e => setAllowRoles(e.target.checked)} />
              Prompt for Role
            </label>
            <p className="text-xs text-muted mt-2">If enabled, users will be required to select a role during registration (this acts as a request, awaiting admin approval).</p>
          </div>

          {/* Canvas */}
          <div 
            style={{ flex: 1, padding: 32, overflowY: 'auto', backgroundColor: '#f0f2f5' }}
            onDrop={(e) => {
              // Handle drop on empty area to move to root level
              e.preventDefault();
              const sourceId = e.dataTransfer.getData('text/plain');
              if (sourceId) {
                setFields(prev => {
                  let { newList, removed } = removeNode(prev, sourceId);
                  if (removed) return [...newList, removed];
                  return prev;
                });
              }
            }}
            onDragOver={handleDragOver}
          >
            {fields.length === 0 ? (
              <div className="text-center text-muted mt-8" style={{ padding: 48, border: '2px dashed var(--border)', borderRadius: 8 }}>
                <h3 className="mb-2">No fields yet</h3>
                <p>Click a field type on the left to get started.</p>
              </div>
            ) : (
              <div className="flex-col gap-2" style={{ maxWidth: 800, margin: '0 auto', paddingBottom: 100 }}>
                {fields.map(renderField)}
              </div>
            )}
          </div>

          {/* Properties Sidebar */}
          {activeField && (
            <FieldSettingsSidebar 
              field={activeField} 
              updateField={updateField} 
              close={() => setActiveFieldId(null)} 
            />
          )}
        </div>
        
        {/* Preview Modal */}
        {showPreview && (
          <div className="modal-overlay" style={{ padding: '24px' }}>
            <div className="modal" style={{ width: previewWidth === 'mobile' ? 400 : 800, height: '90vh', display: 'flex', flexDirection: 'column', transition: 'width 0.3s' }}>
              <div className="flex justify-between items-center mb-4 pb-4 border-bottom">
                <h3>Live Preview</h3>
                <div className="flex gap-2">
                  <button className={`secondary ${previewWidth === 'web' ? '' : 'outline'} flex items-center gap-2`} onClick={() => setPreviewWidth('web')}><FaDesktop /> Web</button>
                  <button className={`secondary ${previewWidth === 'mobile' ? '' : 'outline'} flex items-center gap-2`} onClick={() => setPreviewWidth('mobile')}><FaMobileAlt /> Mobile</button>
                  <button className="icon-btn" onClick={() => setShowPreview(false)}>X</button>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', backgroundColor: '#fff', padding: '32px 24px', borderRadius: 8 }}>
                <FormRenderer 
                  schema={{ fields, allowRoles }} 
                  roles={systemRoles} 
                  onSubmit={(data) => alert('Form submitted in preview! Data:\n' + JSON.stringify(data, null, 2))} 
                />
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2>Registration Builder</h2>
        <button className="primary flex items-center gap-2" onClick={createForm}><FaPlus /> Create Form</button>
      </div>
      
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '24px' }}>
        {forms.map(form => (
          <div key={form.id} className="card">
            <div className="flex justify-between items-center mb-4">
              <h3 style={{ margin: 0 }}>{form.name}</h3>
              <span className={`badge ${form.status.toLowerCase()}`}>{form.status}</span>
            </div>
            <p className="text-muted text-sm mb-4">Version {form.version}</p>
            <p className="text-muted text-sm mb-4">Created: {new Date(form.createdAt).toLocaleDateString()}</p>
            
            <div className="flex gap-2">
              <button className="primary outline" style={{ flex: 1 }} onClick={() => openForm(form)}>
                Edit Form
              </button>
              {form.status !== 'LIVE' && (
                <button className="danger outline" onClick={() => deleteForm(form.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
