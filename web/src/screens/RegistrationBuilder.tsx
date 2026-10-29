import React, { useEffect, useState, useRef } from 'react';
import type { FormField, FormSchema, FieldType } from '../types/form';
import FieldSettingsSidebar from '../components/FormBuilder/FieldSettingsSidebar';
import FormRenderer from '../components/FormBuilder/FormRenderer';
import { 
  removeNode, insertBefore, insertAfter, appendToSection, 
  moveNodeUp, moveNodeDown, duplicateNode, findNode, countAllFields 
} from '../utils/tree';
import { 
  FaGripVertical, FaTrash, FaFolder, FaFont, FaHashtag, FaEnvelope, 
  FaPhone, FaLock, FaCheckSquare, FaCircle, FaCaretSquareDown, 
  FaCalendar, FaImage, FaPlus, FaMobileAlt, FaDesktop, 
  FaExclamationTriangle, FaSpinner, FaCheck, FaSave, FaEye, 
  FaCloudUploadAlt, FaCheckCircle,
  FaArrowUp, FaArrowDown, FaCopy, FaCog, FaSearch, FaWpforms,
  FaClipboardList, FaLayerGroup, FaChevronDown, FaChevronUp, FaTimes, FaEdit,
  FaFingerprint
} from 'react-icons/fa';
import { API_URL } from '../config';
import { useToast } from '../context/ToastContext';
import './RegistrationBuilder.css';

// Palette field definition
interface PaletteField {
  type: FieldType;
  label: string;
  category: 'input' | 'contact' | 'choice' | 'media' | 'layout';
  icon: any;
  hint: string;
}

const PALETTE_FIELDS: PaletteField[] = [
  { type: 'text', label: 'Short Text', category: 'input', icon: FaFont, hint: 'Single-line text for names, titles, codes' },
  { type: 'textarea', label: 'Long Text', category: 'input', icon: FaFont, hint: 'Multi-line comments, remarks, or notes' },
  { type: 'number', label: 'Number', category: 'input', icon: FaHashtag, hint: 'Numeric values, ages, badge numbers' },
  { type: 'password', label: 'Password', category: 'input', icon: FaLock, hint: 'Secure credentials with hash validation' },
  { type: 'email', label: 'Email Address', category: 'contact', icon: FaEnvelope, hint: 'Validated electronic mail address' },
  { type: 'phone', label: 'Mobile Phone', category: 'contact', icon: FaPhone, hint: '10-digit phone for SMS & OTP verification' },
  { type: 'dropdown', label: 'Dropdown Select', category: 'choice', icon: FaCaretSquareDown, hint: 'Pick one option from a dropdown menu' },
  { type: 'radio', label: 'Single Choice (Radio)', category: 'choice', icon: FaCircle, hint: 'Pick one visible radio option' },
  { type: 'checkbox', label: 'Multiple Choice', category: 'choice', icon: FaCheckSquare, hint: 'Select one or multiple checkboxes' },
  { type: 'date', label: 'Date Picker', category: 'media', icon: FaCalendar, hint: 'Calendar date selection' },
  { type: 'image', label: 'Photo / Evidence', category: 'media', icon: FaImage, hint: 'Camera capture or gallery photo upload' },
  { type: 'section', label: 'Section Container', category: 'layout', icon: FaFolder, hint: 'Group related fields inside a collapsible block' },
];

export default function RegistrationBuilder() {
  const [forms, setForms] = useState<any[]>([]);
  const [editingForm, setEditingForm] = useState<any>(null);
  
  // Active Schema
  const [fields, setFields] = useState<FormField[]>([]);
  const [allowRoles, setAllowRoles] = useState(true);
  
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const [builderErrors, setBuilderErrors] = useState<string[]>([]);
  
  // Mobile & Responsive UI State
  const [activeMobileTab, setActiveMobileTab] = useState<'canvas' | 'palette' | 'properties' | 'settings'>('canvas');
  const [propertiesTooltip, setPropertiesTooltip] = useState<{ show: boolean; x: number; y: number } | null>(null);
  const [paletteSearch, setPaletteSearch] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  
  // Drag and Drop Visual States
  const [draggingFieldId, setDraggingFieldId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: 'above' | 'below' | 'inside' } | null>(null);
  const touchSourceIdRef = useRef<string | null>(null);
  const touchDropRef = useRef<{ id: string; position: 'above' | 'below' | 'inside' } | null>(null);
  
  // App state
  const [showPreview, setShowPreview] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<'web' | 'mobile'>('web');
  const [systemRoles, setSystemRoles] = useState<any[]>([]);

  // Action / Button States for UI/UX Acknowledgement
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [publishStatus, setPublishStatus] = useState<'idle' | 'publishing' | 'published' | 'error'>('idle');
  const [previewStatus, setPreviewStatus] = useState<'idle' | 'loading'>('idle');
  const [isCreatingForm, setIsCreatingForm] = useState(false);
  const [deletingFormId, setDeletingFormId] = useState<number | null>(null);
  const { success: toastSuccess, error: toastError, warning: _toastWarning, info: toastInfo } = useToast();

  const showToast = (message: string, type: 'success' | 'danger' | 'info' = 'success') => {
    if (type === 'danger') {
      toastError(message, 'Registration Builder');
    } else if (type === 'info') {
      toastInfo(message, 'Registration Builder');
    } else {
      toastSuccess(message, 'Registration Builder');
    }
  };

  const fetchForms = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/registration-forms`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        setForms(data);
      }
    } catch (err) {
      console.error('Error fetching forms:', err);
    }
  };

  const fetchRoles = async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/roles`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) {
        setSystemRoles(data);
      }
    } catch (err) {
      console.error('Error fetching roles:', err);
    }
  };

  useEffect(() => {
    fetchForms();
    fetchRoles();
  }, []);

  const createForm = async () => {
    setIsCreatingForm(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/registration-forms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ 
          name: `Registration Form v${forms.length + 1}`, 
          schema: JSON.stringify({ fields: [], allowRoles: true }) 
        })
      });
      const data = await res.json();
      setForms([data, ...forms]);
      showToast('New registration template created!');
      openForm(data);
    } catch (err) {
      console.error(err);
      showToast('Failed to create form template', 'danger');
    } finally {
      setIsCreatingForm(false);
    }
  };

  const deleteForm = async (id: number) => {
    if (!confirm('Are you sure you want to delete this registration template?')) return;
    setDeletingFormId(id);
    try {
      const res = await fetch(`${API_URL}/api/v1/registration-forms/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      if (res.ok) {
        setForms(forms.filter(f => f.id !== id));
        showToast('Template deleted successfully');
      } else {
        const err = await res.json();
        showToast(err.error || 'Failed to delete template', 'danger');
      }
    } catch (err) {
      console.error(err);
      showToast('Error deleting template', 'danger');
    } finally {
      setDeletingFormId(null);
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
    setSaveStatus('idle');
    setPublishStatus('idle');
    setPreviewStatus('idle');
    setActiveMobileTab('canvas');
  };

  const closeForm = () => {
    if (confirm('Leave without saving? Any unsaved changes will be lost.')) {
      setEditingForm(null);
      setFields([]);
      setSaveStatus('idle');
      setPublishStatus('idle');
      setPreviewStatus('idle');
    }
  };

  // --- Validation ---
  const validateBuilder = (): string[] => {
    const errors: string[] = [];
    const keys = new Set<string>();

    const checkField = (f: FormField) => {
      if (!f.label || f.label.trim() === '') errors.push(`Field or section is missing a label (ID: ${f.id})`);
      if (f.type !== 'section') {
        if (!f.name || f.name.trim() === '') errors.push(`Field '${f.label || 'Untitled'}' is missing an API Key slug`);
        if (keys.has(f.name)) errors.push(`Duplicate API Key found: '${f.name}'`);
        keys.add(f.name);
      }
      if (['dropdown', 'radio', 'checkbox'].includes(f.type)) {
        if (!f.options || f.options.length === 0) errors.push(`Field '${f.label}' must have at least one choice option.`);
        const optValues = new Set<string>();
        f.options?.forEach(o => {
          if (optValues.has(o.value)) errors.push(`Field '${f.label}' has duplicate option value: '${o.value}'`);
          optValues.add(o.value);
        });
      }
      if (f.validation) {
        if (f.validation.minLength && f.validation.maxLength && f.validation.minLength > f.validation.maxLength) {
          errors.push(`Field '${f.label}' has contradictory validation (Min Length > Max Length)`);
        }
      }
      if (f.children) {
        f.children.forEach(checkField);
      }
    };

    fields.forEach(checkField);

    let hasRequiredEmail = false;
    let hasRequiredPhone = false;
    const checkContactFields = (f: FormField) => {
      if ((f.type === 'email' || f.name.toLowerCase().includes('email')) && f.required) {
        hasRequiredEmail = true;
      }
      if ((f.type === 'phone' || f.name.toLowerCase().includes('mobile') || f.name.toLowerCase().includes('phone')) && f.required) {
        hasRequiredPhone = true;
      }
      if (f.children) f.children.forEach(checkContactFields);
    };
    fields.forEach(checkContactFields);

    if (!hasRequiredEmail && !hasRequiredPhone) {
      errors.push('Registration form must have at least one required contact method (Email or Mobile Phone marked as Required) for OTP security & credentials.');
    }

    return errors;
  };

  const handlePreview = () => {
    const errors = validateBuilder();
    setBuilderErrors(errors);
    setPreviewStatus('loading');
    setTimeout(() => {
      setShowPreview(true);
      setPreviewStatus('idle');
      if (errors.length > 0) {
        showToast(`Preview active with ${errors.length} validation warning(s)`, 'info');
      } else {
        showToast('Live preview generated successfully');
      }
    }, 200);
  };

  const saveForm = async () => {
    if (!editingForm) return;
    
    const errors = validateBuilder();
    if (errors.length > 0) {
      if (!confirm(`Warning: Your template has ${errors.length} validation issues. Save draft anyway?`)) return;
    }

    setSaveStatus('saving');
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
        setSaveStatus('saved');
        showToast('Draft saved successfully!');
        fetchForms();
        setTimeout(() => setSaveStatus('idle'), 2500);
      } else {
        const err = await res.json();
        setSaveStatus('error');
        showToast(err.error || 'Failed to save draft', 'danger');
        setTimeout(() => setSaveStatus('idle'), 2500);
      }
    } catch (err) {
      console.error(err);
      setSaveStatus('error');
      showToast('Error saving draft template', 'danger');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }
  };

  const publishForm = async () => {
    if (!editingForm) return;
    const errors = validateBuilder();
    if (errors.length > 0) {
      setBuilderErrors(errors);
      showToast('Cannot publish. Please resolve validation errors.', 'danger');
      return;
    }

    if (confirm('Are you sure you want to publish this form? This will become the LIVE registration form for all new users.')) {
      setPublishStatus('publishing');
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
          setPublishStatus('published');
          showToast('Form published successfully! Now LIVE for registrations.');
          setTimeout(() => {
            fetchForms();
            setEditingForm(null);
            setPublishStatus('idle');
          }, 1500);
        } else {
          const err = await res.json();
          setPublishStatus('error');
          showToast(err.error || 'Failed to publish form', 'danger');
          setTimeout(() => setPublishStatus('idle'), 2500);
        }
      } catch (err) {
        console.error(err);
        setPublishStatus('error');
        showToast('Error publishing form live', 'danger');
        setTimeout(() => setPublishStatus('idle'), 2500);
      }
    }
  };

  // --- HTML5 Desktop Drag and Drop Handlers ---
  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.setData('application/json', JSON.stringify({ id, kind: 'existing' }));
    setDraggingFieldId(id);
    e.stopPropagation();
  };

  const handlePaletteDragStart = (e: React.DragEvent, type: FieldType) => {
    e.dataTransfer.setData('text/plain', `palette:${type}`);
    e.dataTransfer.setData('application/json', JSON.stringify({ type, kind: 'palette' }));
    e.stopPropagation();
  };

  const handleDropOnField = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    const currentPosition = dropTarget?.id === targetId ? dropTarget.position : 'below';
    setDropTarget(null);
    setDraggingFieldId(null);

    const sourceData = e.dataTransfer.getData('text/plain');
    if (!sourceData) return;

    if (sourceData.startsWith('palette:')) {
      const type = sourceData.replace('palette:', '') as FieldType;
      const created = createNewFieldObject(type);
      setFields(prev => {
        if (currentPosition === 'above') {
          return insertBefore(prev, targetId, created);
        } else {
          return insertAfter(prev, targetId, created);
        }
      });
      setActiveFieldId(created.id);
      showToast(`Added ${created.label}`);
      return;
    }

    if (sourceData === targetId) return;

    setFields(prev => {
      let { newList, removed } = removeNode(prev, sourceData);
      if (removed) {
        if (currentPosition === 'above') {
          return insertBefore(newList, targetId, removed);
        } else {
          return insertAfter(newList, targetId, removed);
        }
      }
      return prev;
    });
  };

  const handleDropOnSection = (e: React.DragEvent, sectionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDraggingFieldId(null);

    const sourceData = e.dataTransfer.getData('text/plain');
    if (!sourceData) return;

    if (sourceData.startsWith('palette:')) {
      const type = sourceData.replace('palette:', '') as FieldType;
      const created = createNewFieldObject(type);
      setFields(prev => appendToSection(prev, sectionId, created));
      setActiveFieldId(created.id);
      showToast(`Added ${created.label} to section`);
      return;
    }

    if (sourceData === sectionId) return;

    setFields(prev => {
      let { newList, removed } = removeNode(prev, sourceData);
      if (removed) {
        return appendToSection(newList, sectionId, removed);
      }
      return prev;
    });
  };

  const handleDragOver = (e: React.DragEvent, targetId?: string, isSectionZone = false) => {
    e.preventDefault();
    e.stopPropagation();
    if (!targetId) return;

    if (isSectionZone) {
      if (dropTarget?.id !== targetId || dropTarget?.position !== 'inside') {
        setDropTarget({ id: targetId, position: 'inside' });
      }
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const position = e.clientY < midpoint ? 'above' : 'below';

    if (!dropTarget || dropTarget.id !== targetId || dropTarget.position !== position) {
      setDropTarget({ id: targetId, position });
    }
  };

  const handleDragLeave = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    if (dropTarget?.id === targetId) {
      setDropTarget(null);
    }
  };

  const handleDragEnd = () => {
    setDraggingFieldId(null);
    setDropTarget(null);
  };

  // --- Mobile Touch Drag Reordering ---
  const handleTouchStart = (id: string) => {
    touchSourceIdRef.current = id;
    setDraggingFieldId(id);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchSourceIdRef.current) return;
    const touch = e.touches[0];
    const elem = document.elementFromPoint(touch.clientX, touch.clientY);
    const cardElem = elem?.closest('[data-field-id]') as HTMLElement;
    if (cardElem) {
      const targetId = cardElem.getAttribute('data-field-id');
      if (targetId) {
        const rect = cardElem.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        const position = touch.clientY < midpoint ? 'above' : 'below';
        touchDropRef.current = { id: targetId, position };
        setDropTarget({ id: targetId, position });
      }
    }
  };

  const handleTouchEnd = () => {
    const sourceId = touchSourceIdRef.current;
    const targetInfo = touchDropRef.current;
    if (sourceId && targetInfo && sourceId !== targetInfo.id) {
      setFields(prev => {
        let { newList, removed } = removeNode(prev, sourceId);
        if (removed) {
          if (targetInfo.position === 'above') {
            return insertBefore(newList, targetInfo.id, removed);
          } else {
            return insertAfter(newList, targetInfo.id, removed);
          }
        }
        return prev;
      });
      showToast('Field reordered successfully');
    }
    touchSourceIdRef.current = null;
    touchDropRef.current = null;
    setDraggingFieldId(null);
    setDropTarget(null);
  };

  // --- Tree Manipulations ---
  const createNewFieldObject = (type: FieldType): FormField => {
    const defaultLabels: Record<FieldType, string> = {
      text: 'Full Name',
      textarea: 'Additional Remarks',
      number: 'Employee Badge Number',
      email: 'Email Address',
      phone: 'Mobile Phone Number',
      password: 'Create Password',
      dropdown: 'Department / Section',
      radio: 'Gender / Category',
      checkbox: 'Agreed Declarations',
      date: 'Date of Joining',
      image: 'Government ID Proof',
      section: 'Personal Details'
    };

    const defaultKeys: Record<FieldType, string> = {
      text: `fullName_${Date.now().toString().slice(-4)}`,
      textarea: `remarks_${Date.now().toString().slice(-4)}`,
      number: `badgeNumber_${Date.now().toString().slice(-4)}`,
      email: `email`,
      phone: `mobile`,
      password: `password`,
      dropdown: `department_${Date.now().toString().slice(-4)}`,
      radio: `category_${Date.now().toString().slice(-4)}`,
      checkbox: `declarations_${Date.now().toString().slice(-4)}`,
      date: `joiningDate_${Date.now().toString().slice(-4)}`,
      image: `idProof_${Date.now().toString().slice(-4)}`,
      section: ''
    };

    return {
      id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 4),
      type,
      name: defaultKeys[type],
      label: defaultLabels[type] || 'New Field',
      children: type === 'section' ? [] : undefined,
      required: ['email', 'phone', 'text'].includes(type),
      unique: ['email', 'phone'].includes(type),
      options: ['dropdown', 'radio', 'checkbox'].includes(type) ? [
        { id: `${Date.now()}_1`, label: 'Option 1', value: 'option_1' },
        { id: `${Date.now()}_2`, label: 'Option 2', value: 'option_2' }
      ] : undefined
    };
  };

  const handleAddField = (type: FieldType, targetSectionId?: string) => {
    const newField = createNewFieldObject(type);
    if (targetSectionId) {
      setFields(prev => appendToSection(prev, targetSectionId, newField));
    } else {
      setFields(prev => [...prev, newField]);
    }
    setActiveFieldId(newField.id);
    setActiveMobileTab('properties');
    showToast(`Added "${newField.label}"`);
  };

  const handleDuplicateField = (id: string) => {
    const { newList, duplicatedId } = duplicateNode(fields, id);
    setFields(newList);
    if (duplicatedId) {
      setActiveFieldId(duplicatedId);
      showToast('Field duplicated successfully!');
    }
  };

  const handleMoveUp = (id: string) => {
    setFields(prev => moveNodeUp(prev, id));
  };

  const handleMoveDown = (id: string) => {
    setFields(prev => moveNodeDown(prev, id));
  };

  const handleDeleteField = (id: string) => {
    if (confirm('Delete this field? If it is a section, all nested fields will also be deleted.')) {
      setFields(prev => removeNode(prev, id).newList);
      if (activeFieldId === id) {
        setActiveFieldId(null);
        if (activeMobileTab === 'properties') {
          setActiveMobileTab('canvas');
        }
      }
      showToast('Field deleted');
    }
  };

  const toggleSectionCollapse = (sectionId: string) => {
    setCollapsedSections(prev => ({ ...prev, [sectionId]: !prev[sectionId] }));
  };

  // --- Render Single Field Card ---
  const renderField = (field: FormField, _parentIsSection = false) => {
    const isActive = activeFieldId === field.id;
    const isDragging = draggingFieldId === field.id;
    const isTargetAbove = dropTarget?.id === field.id && dropTarget.position === 'above';
    const isTargetBelow = dropTarget?.id === field.id && dropTarget.position === 'below';
    const isTargetInside = dropTarget?.id === field.id && dropTarget.position === 'inside';
    const isSection = field.type === 'section';
    const isCollapsed = collapsedSections[field.id] || false;

    return (
      <div 
        key={field.id}
        data-field-id={field.id}
        draggable
        onDragStart={(e) => handleDragStart(e, field.id)}
        onDragOver={(e) => handleDragOver(e, field.id)}
        onDragLeave={(e) => handleDragLeave(e, field.id)}
        onDrop={(e) => handleDropOnField(e, field.id)}
        onDragEnd={handleDragEnd}
        className={`field-card ${isSection ? 'is-section' : ''} ${isActive ? 'is-active' : ''} ${isDragging ? 'is-dragging' : ''} ${isTargetAbove ? 'drop-target-above' : ''} ${isTargetBelow ? 'drop-target-below' : ''}`}
        onClick={(e) => { 
          e.stopPropagation(); 
          setActiveFieldId(field.id);
        }}
      >
        {/* Sharp Reflective Blue Insertion Guideline Above */}
        {isTargetAbove && <div className="drop-indicator-line above" />}

        <div className="field-card-header">
          <div className="field-card-left">
            {/* Drag Handle with Touch and Mouse support */}
            <div 
              className="field-drag-grip"
              title="Drag to reorder"
              onTouchStart={() => handleTouchStart(field.id)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <FaGripVertical />
            </div>

            {/* Aligned Left Corner * Req / Section Badge */}
            <div className="field-req-corner-slot">
              {isSection ? (
                <span className="section-icon-badge" title="Section Container">
                  <FaFolder />
                </span>
              ) : field.required ? (
                <span className="field-req-corner-badge" title="Required Mandatory Field">
                  * Req
                </span>
              ) : null}
            </div>

            <div className="field-title-badge-group">
              <span className="field-name-title">
                {field.label || 'Untitled Field'}
              </span>
              <span className="field-type-pill">
                {field.type}
              </span>
              {field.type !== 'section' && field.name && (
                <span className="field-key-slug">
                  {field.name}
                </span>
              )}
              {field.unique && (
                <span className="field-unique-pill" title="Unique Identifier (Value cannot be duplicated across users)">
                  <FaFingerprint style={{ marginRight: '3px', fontSize: '0.65rem' }} /> Unique
                </span>
              )}
            </div>
          </div>

          {/* Quick Action Toolbar (Reorder, Settings, Clone, Delete) */}
          <div className="field-card-actions">
            <button 
              type="button"
              className="btn-field-action" 
              onClick={(e) => { e.stopPropagation(); handleMoveUp(field.id); }}
              title="Move Up"
            >
              <FaArrowUp />
            </button>
            <button 
              type="button"
              className="btn-field-action" 
              onClick={(e) => { e.stopPropagation(); handleMoveDown(field.id); }}
              title="Move Down"
            >
              <FaArrowDown />
            </button>
            <button 
              type="button"
              className={`btn-field-action ${isActive ? 'primary-action' : ''}`}
              onClick={(e) => { 
                e.stopPropagation(); 
                setActiveFieldId(field.id); 
                setActiveMobileTab('properties');
              }}
              title="Edit Field Properties"
            >
              <FaCog />
            </button>
            <button 
              type="button"
              className="btn-field-action" 
              onClick={(e) => { e.stopPropagation(); handleDuplicateField(field.id); }}
              title="Duplicate Field"
            >
              <FaCopy />
            </button>
            <button 
              type="button"
              className="btn-field-action btn-danger-action" 
              onClick={(e) => { e.stopPropagation(); handleDeleteField(field.id); }}
              title="Delete Field"
              aria-label="Delete Field"
            >
              <FaTrash />
            </button>
            {isSection && (
              <button 
                type="button"
                className="btn-field-action" 
                onClick={(e) => { e.stopPropagation(); toggleSectionCollapse(field.id); }}
                title={isCollapsed ? 'Expand Section' : 'Collapse Section'}
              >
                {isCollapsed ? <FaChevronDown /> : <FaChevronUp />}
              </button>
            )}
          </div>
        </div>

        {/* Sharp Reflective Blue Insertion Guideline Below */}
        {isTargetBelow && <div className="drop-indicator-line below" />}
        
        {/* Section Child Zone */}
        {isSection && !isCollapsed && (
          <div 
            className={`section-children-zone ${isTargetInside ? 'drop-target-inside' : ''}`}
            onDrop={(e) => handleDropOnSection(e, field.id)}
            onDragOver={(e) => handleDragOver(e, field.id, true)}
            onDragLeave={(e) => handleDragLeave(e, field.id)}
          >
            {field.children && field.children.length > 0 ? (
              field.children.map(child => renderField(child, true))
            ) : (
              <div className="section-drop-zone-empty">
                Drag fields here or tap "+ Add Field inside"
              </div>
            )}
            
            <button 
              type="button"
              className="section-add-btn" 
              onClick={(e) => {
                e.stopPropagation();
                handleAddField('text', field.id);
              }}
            >
              <FaPlus /> Add Field Inside Section
            </button>
          </div>
        )}
      </div>
    );
  };

  // --- Active Field for Inspector ---
  const activeField = activeFieldId ? findNode(fields, activeFieldId) : null;

  // Filtered Palette
  const filteredPalette = PALETTE_FIELDS.filter(p => 
    p.label.toLowerCase().includes(paletteSearch.toLowerCase()) || 
    p.hint.toLowerCase().includes(paletteSearch.toLowerCase()) ||
    p.category.toLowerCase().includes(paletteSearch.toLowerCase())
  );

  // Grouped Palette
  const paletteCategories: Array<{ key: PaletteField['category']; title: string }> = [
    { key: 'input', title: 'Text & Input' },
    { key: 'contact', title: 'Contact & Verification' },
    { key: 'choice', title: 'Options & Choices' },
    { key: 'media', title: 'Media & Date' },
    { key: 'layout', title: 'Sections & Layout' }
  ];

  // Filtered Templates
  const filteredTemplates = forms.filter(f => 
    f.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
    f.status.toLowerCase().includes(templateSearch.toLowerCase())
  );

  // --- Render Editor Console View ---
  if (editingForm) {
    const totalFieldsCount = countAllFields(fields);

    return (
      <div className="reg-builder-root">
        {/* Top Header Console Bar */}
        <div className="reg-editor-header">
          <div className="reg-editor-title-container">
            <div className="reg-title-input-wrapper">
              <input 
                type="text" 
                value={editingForm.name} 
                onChange={e => setEditingForm({ ...editingForm, name: e.target.value })}
                className="reg-title-input"
                placeholder="Registration Form Title..."
                title="Click to rename registration template"
              />
            </div>
            <div className="reg-editor-meta-row">
              <span className={`reg-status-pill ${editingForm.status.toLowerCase()}`}>
                {editingForm.status === 'LIVE' && <span className="reg-pulse-dot" />}
                {editingForm.status}
              </span>
              <span>Version {editingForm.version}</span>
              <span>•</span>
              <span>{totalFieldsCount} Field{totalFieldsCount === 1 ? '' : 's'}</span>
            </div>
          </div>

          <div className="reg-editor-actions-group">
            <button 
              className="btn-editor cancel" 
              onClick={closeForm}
              title="Close editor and discard unsaved changes"
            >
              Cancel
            </button>
            <button 
              className="btn-editor preview" 
              disabled={previewStatus === 'loading'}
              onClick={handlePreview}
              title="Preview form on web and mobile devices"
            >
              {previewStatus === 'loading' ? (
                <>
                  <FaSpinner className="spin" /> Opening...
                </>
              ) : (
                <>
                  <FaEye /> Preview
                </>
              )}
            </button>
            <button 
              className={`btn-editor save ${saveStatus === 'saved' ? 'btn-success-state' : ''}`}
              disabled={saveStatus === 'saving'}
              onClick={saveForm}
              title="Save changes as draft template"
            >
              {saveStatus === 'saving' ? (
                <>
                  <FaSpinner className="spin" /> Saving...
                </>
              ) : saveStatus === 'saved' ? (
                <>
                  <FaCheck /> Saved!
                </>
              ) : (
                <>
                  <FaSave /> Save Draft
                </>
              )}
            </button>
            <button 
              className={`btn-editor publish ${publishStatus === 'published' ? 'btn-success-state' : ''}`}
              disabled={publishStatus === 'publishing'}
              onClick={publishForm}
              title="Publish form live for public user registrations"
            >
              {publishStatus === 'publishing' ? (
                <>
                  <FaSpinner className="spin" /> Publishing...
                </>
              ) : publishStatus === 'published' ? (
                <>
                  <FaCheck /> Live!
                </>
              ) : (
                <>
                  <FaCloudUploadAlt /> Publish Live
                </>
              )}
            </button>
          </div>
        </div>

        {/* Validation Errors Alert Banner */}
        {builderErrors.length > 0 && (
          <div className="reg-validation-banner">
            <FaExclamationTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>Form Validation Warning:</strong>
              <ul>
                {builderErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Mobile Segmented Navigation Tabs (< 1024px) */}
        <div className="reg-mobile-nav-tabs">
          <button 
            type="button"
            className={`reg-mobile-tab-btn ${activeMobileTab === 'canvas' ? 'active' : ''}`}
            onClick={() => setActiveMobileTab('canvas')}
          >
            <FaWpforms /> Canvas <span className="tab-badge">{totalFieldsCount}</span>
          </button>
          <button 
            type="button"
            className={`reg-mobile-tab-btn ${activeMobileTab === 'palette' ? 'active' : ''}`}
            onClick={() => setActiveMobileTab('palette')}
          >
            <FaPlus /> + Add Field
          </button>
          <div 
            className="reg-mobile-tab-wrapper"
            onMouseEnter={(e) => {
              if (!activeField) {
                const rect = e.currentTarget.getBoundingClientRect();
                setPropertiesTooltip({
                  show: true,
                  x: rect.left + rect.width / 2,
                  y: rect.bottom + 8
                });
              }
            }}
            onMouseLeave={() => setPropertiesTooltip(null)}
          >
            <button 
              type="button"
              className={`reg-mobile-tab-btn ${activeMobileTab === 'properties' ? 'active' : ''} ${!activeField ? 'disabled' : ''}`}
              disabled={!activeField}
              onClick={() => {
                if (!activeField) {
                  showToast('Please select a field first', 'info');
                  return;
                }
                setActiveMobileTab('properties');
              }}
            >
              <FaCog /> Properties {activeField ? `(${activeField.label.slice(0, 10)})` : ''}
            </button>
          </div>
          <button 
            type="button"
            className={`reg-mobile-tab-btn ${activeMobileTab === 'settings' ? 'active' : ''}`}
            onClick={() => setActiveMobileTab('settings')}
          >
            <FaLayerGroup /> Settings
          </button>
        </div>

        {/* Workspace 3-Column / Responsive Layout */}
        <div className="reg-workspace">
          {/* LEFT PALETTE PANEL: Visible on Desktop or when mobile tab is 'palette' */}
          <div 
            className="builder-palette-panel"
            style={{ 
              display: window.innerWidth <= 1024 && activeMobileTab !== 'palette' ? 'none' : 'flex' 
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>Field Library</h3>
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                  Drag or tap to add
                </span>
              </div>
              
              {/* Search box for palette */}
              <div style={{ position: 'relative' }}>
                <input 
                  type="text" 
                  value={paletteSearch} 
                  onChange={e => setPaletteSearch(e.target.value)}
                  placeholder="Search field types..."
                  style={{ 
                    width: '100%', 
                    padding: '0.45rem 0.65rem 0.45rem 1.8rem', 
                    borderRadius: '8px', 
                    border: '1px solid #cbd5e1',
                    fontSize: '0.8rem'
                  }}
                />
                <FaSearch style={{ position: 'absolute', left: '0.65rem', top: '0.6rem', color: '#94a3b8', fontSize: '0.75rem' }} />
              </div>
            </div>

            {/* Categorized Fields List */}
            {paletteCategories.map(cat => {
              const catFields = filteredPalette.filter(f => f.category === cat.key);
              if (catFields.length === 0) return null;
              return (
                <div key={cat.key}>
                  <div className="palette-category-title">
                    {cat.title}
                  </div>
                  <div className="palette-grid">
                    {catFields.map(f => (
                      <button 
                        key={f.type}
                        type="button"
                        draggable
                        onDragStart={(e) => handlePaletteDragStart(e, f.type)}
                        className="palette-item-btn"
                        onClick={() => {
                          handleAddField(f.type);
                          if (window.innerWidth <= 1024) {
                            setActiveMobileTab('canvas');
                          }
                        }}
                        title={`${f.label}: ${f.hint} (Drag into canvas or tap to add)`}
                      >
                        <div className={`palette-icon-wrapper ${f.category}`}>
                          <f.icon />
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', lineHeight: 1.2 }}>{f.label}</span>
                        </div>
                        <FaPlus style={{ color: '#94a3b8', fontSize: '0.75rem' }} />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Mobile Form Settings Option in Palette Panel */}
            <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem', marginTop: 'auto' }}>
              <div className="palette-category-title">
                Role Assignment Request
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.825rem', fontWeight: 600, cursor: 'pointer' }}>
                <input 
                  type="checkbox" 
                  checked={allowRoles} 
                  onChange={e => setAllowRoles(e.target.checked)}
                  style={{ width: '16px', height: '16px' }} 
                />
                Allow Role Selection on Form
              </label>
              <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0.35rem 0 0 0' }}>
                Prompts applicants to request a designated role (e.g. Gatesman, Section Master). Admins can approve or alter it.
              </p>
            </div>
          </div>

          {/* MIDDLE CANVAS PANEL: Visible on Desktop or when mobile tab is 'canvas' */}
          <div 
            className="builder-canvas-panel"
            style={{ 
              display: window.innerWidth <= 1024 && activeMobileTab !== 'canvas' ? 'none' : 'flex' 
            }}
            onDrop={(e) => {
              e.preventDefault();
              const sourceData = e.dataTransfer.getData('text/plain');
              if (sourceData.startsWith('palette:')) {
                const type = sourceData.replace('palette:', '') as FieldType;
                handleAddField(type);
                return;
              }
              if (sourceData) {
                setFields(prev => {
                  let { newList, removed } = removeNode(prev, sourceData);
                  if (removed) return [...newList, removed];
                  return prev;
                });
              }
            }}
            onDragOver={handleDragOver}
          >
            <div className="canvas-container">
              {fields.length === 0 ? (
                <div className="canvas-empty-state">
                  <div className="canvas-empty-icon">
                    <FaWpforms />
                  </div>
                  <div>
                    <h3 style={{ margin: '0 0 0.35rem 0', fontSize: '1.25rem', color: '#0f172a' }}>
                      Start Building Your Registration Form
                    </h3>
                    <p style={{ margin: 0, fontSize: '0.875rem' }}>
                      Drag elements from the left palette or tap "+ Add Field" below to begin.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button 
                      type="button"
                      className="btn-editor save" 
                      onClick={() => handleAddField('text')}
                    >
                      <FaPlus /> Add Full Name
                    </button>
                    <button 
                      type="button"
                      className="btn-editor save" 
                      onClick={() => handleAddField('phone')}
                    >
                      <FaPlus /> Add Phone (SMS/OTP)
                    </button>
                    <button 
                      type="button"
                      className="btn-editor save" 
                      onClick={() => handleAddField('email')}
                    >
                      <FaPlus /> Add Email
                    </button>
                    <button 
                      type="button"
                      className="btn-editor save" 
                      onClick={() => handleAddField('section')}
                    >
                      <FaPlus /> Add Section
                    </button>
                  </div>
                </div>
              ) : (
                fields.map(f => renderField(f))
              )}
            </div>
          </div>

          {/* RIGHT INSPECTOR PANEL: Visible on Desktop (if activeField exists) or when mobile tab is 'properties' */}
          {activeField ? (
            <div 
              style={{ 
                display: window.innerWidth <= 1024 && activeMobileTab !== 'properties' ? 'none' : 'flex' 
              }}
            >
              <FieldSettingsSidebar 
                field={activeField} 
                updateField={(id, updates) => {
                  const mapFields = (list: FormField[]): FormField[] => {
                    return list.map(f => {
                      if (f.id === id) return { ...f, ...updates };
                      if (f.children) return { ...f, children: mapFields(f.children) };
                      return f;
                    });
                  };
                  setFields(prev => mapFields(prev));
                }} 
                close={() => {
                  setActiveFieldId(null);
                  if (window.innerWidth <= 1024) {
                    setActiveMobileTab('canvas');
                  }
                }} 
              />
            </div>
          ) : (
            activeMobileTab === 'properties' && (
              <div 
                className="builder-canvas-panel" 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  width: '100%',
                  padding: '2rem 1rem'
                }}
              >
                <div className="canvas-empty-state" style={{ maxWidth: '440px', width: '100%', margin: '2rem auto' }}>
                  <div className="canvas-empty-icon" style={{ background: 'rgba(11, 60, 122, 0.08)', color: 'var(--primary, #0b3c7a)' }}>
                    <FaCog />
                  </div>
                  <div>
                    <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.2rem', color: '#0f172a' }}>
                      No Field Selected
                    </h3>
                    <p style={{ margin: 0, fontSize: '0.875rem', color: '#64748b' }}>
                      Please select a field from the Canvas or tap its gear icon ⚙️ to view and customize its properties.
                    </p>
                  </div>
                  <button 
                    type="button" 
                    className="btn-editor save" 
                    onClick={() => setActiveMobileTab('canvas')}
                  >
                    <FaWpforms /> Return to Canvas
                  </button>
                </div>
              </div>
            )
          )}

          {/* MOBILE FORM SETTINGS TAB: Displayed when mobile tab is 'settings' */}
          {activeMobileTab === 'settings' && (
            <div 
              className="builder-inspector-panel" 
              style={{ display: 'flex', width: '100%', padding: '1.25rem' }}
            >
              <h3 style={{ margin: '0 0 1rem 0' }}>Form Configuration</h3>
              <div className="inspector-group" style={{ marginBottom: '1rem' }}>
                <label>Template Name</label>
                <input 
                  type="text" 
                  value={editingForm.name} 
                  onChange={e => setEditingForm({ ...editingForm, name: e.target.value })}
                />
              </div>

              <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '10px', border: '1px solid #e2e8f0', marginBottom: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontWeight: 600 }}>
                  <input 
                    type="checkbox" 
                    checked={allowRoles} 
                    onChange={e => setAllowRoles(e.target.checked)} 
                    style={{ width: '18px', height: '18px' }}
                  />
                  Require Role Selection
                </label>
                <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '0.4rem 0 0 0' }}>
                  When checked, users can choose their requested organizational role when registering.
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
                <button 
                  type="button"
                  className="btn-editor save" 
                  style={{ flex: 1 }} 
                  onClick={() => setActiveMobileTab('canvas')}
                >
                  Return to Canvas
                </button>
              </div>
            </div>
          )}
        </div>

        {/* LIVE PREVIEW MODAL */}
        {showPreview && (
          <div className="reg-preview-modal-overlay">
            <div className={`reg-preview-window ${previewWidth}`}>
              {/* Preview Toolbar */}
              <div className="preview-top-toolbar">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <strong style={{ fontSize: '1rem', color: 'var(--text-main, #0f172a)' }}>
                    Live Registration Preview
                  </strong>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  {/* Device Viewport Toggle */}
                  <div className="preview-device-toggle">
                    <button 
                      type="button"
                      className={`btn-device-toggle ${previewWidth === 'web' ? 'active' : ''}`}
                      onClick={() => setPreviewWidth('web')}
                      title="Desktop browser viewport"
                    >
                      <FaDesktop /> Desktop
                    </button>
                    <button 
                      type="button"
                      className={`btn-device-toggle ${previewWidth === 'mobile' ? 'active' : ''}`}
                      onClick={() => setPreviewWidth('mobile')}
                      title="Mobile phone viewport"
                    >
                      <FaMobileAlt /> Mobile
                    </button>
                  </div>

                  <button 
                    type="button"
                    className="btn-field-action" 
                    onClick={() => setShowPreview(false)}
                    title="Close preview"
                  >
                    <FaTimes />
                  </button>
                </div>
              </div>

              {/* Preview Content Area */}
              <div className="preview-content-area">
                {previewWidth === 'mobile' ? (
                  <div className="smartphone-frame">
                    <div className="smartphone-notch" />
                    <FormRenderer 
                      schema={{ fields, allowRoles }} 
                      roles={systemRoles} 
                      onSubmit={(data) => {
                        toastSuccess(`Preview Form Submitted! Form validation and data capture verified (${Object.keys(data).length} fields).`, 'Preview Form');
                      }} 
                    />
                  </div>
                ) : (
                  <div style={{ width: '100%', maxWidth: '780px', background: '#ffffff', padding: '2rem', borderRadius: '12px', boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}>
                    <FormRenderer 
                      schema={{ fields, allowRoles }} 
                      roles={systemRoles} 
                      onSubmit={(data) => {
                        toastSuccess(`Preview Form Submitted! Form validation and data capture verified (${Object.keys(data).length} fields).`, 'Preview Form');
                      }} 
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Floating Screen-Level Tooltip (Completely outside scroll containers) */}
        {propertiesTooltip?.show && (
          <div 
            className="screen-floating-tooltip"
            style={{
              position: 'fixed',
              top: propertiesTooltip.y,
              left: propertiesTooltip.x,
              transform: 'translateX(-50%)',
              zIndex: 999999
            }}
          >
            <div className="tooltip-arrow-top" />
            <span>Please select a field</span>
          </div>
        )}
      </div>
    );
  }

  // --- Render Dashboard / Template Catalog View ---
  const totalTemplates = forms.length;
  const liveTemplate = forms.find(f => f.status === 'LIVE');
  const liveFieldCount = liveTemplate ? (() => {
    try {
      const p = JSON.parse(liveTemplate.schema);
      return countAllFields(p.fields || []);
    } catch {
      return 0;
    }
  })() : 0;

  return (
    <div className="reg-builder-root">
      <div className="reg-builder-dashboard">
        {/* Real-time Metric Stats Cards */}
        <div className="reg-stats-grid">
          <div className="reg-stat-card">
            <div className="reg-stat-icon primary">
              <FaClipboardList />
            </div>
            <div className="reg-stat-info">
              <span className="reg-stat-label">Total Templates</span>
              <span className="reg-stat-val">{totalTemplates}</span>
            </div>
          </div>

          <div className="reg-stat-card">
            <div className="reg-stat-icon success">
              <FaCheckCircle />
            </div>
            <div className="reg-stat-info">
              <span className="reg-stat-label">Active Live Form</span>
              <span className="reg-stat-val" style={{ fontSize: '1.1rem' }}>
                {liveTemplate ? liveTemplate.name : 'None Live'}
              </span>
            </div>
          </div>

          <div className="reg-stat-card">
            <div className="reg-stat-icon info">
              <FaLayerGroup />
            </div>
            <div className="reg-stat-info">
              <span className="reg-stat-label">Live Form Fields</span>
              <span className="reg-stat-val">{liveFieldCount}</span>
            </div>
          </div>

          <div className="reg-stat-card">
            <div className="reg-stat-icon warning">
              <FaMobileAlt />
            </div>
            <div className="reg-stat-info">
              <span className="reg-stat-label">Console Engine</span>
              <span className="reg-stat-val" style={{ fontSize: '1.1rem' }}>
                Mobile Responsive
              </span>
            </div>
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          <div style={{ position: 'relative', flex: 1, maxWidth: '400px' }}>
            <input 
              type="text" 
              value={templateSearch} 
              onChange={e => setTemplateSearch(e.target.value)}
              placeholder="Search registration templates..."
              style={{ 
                width: '100%', 
                padding: '0.6rem 0.85rem 0.6rem 2.2rem', 
                borderRadius: '10px', 
                border: '1px solid #cbd5e1',
                fontSize: '0.875rem',
                background: '#ffffff'
              }}
            />
            <FaSearch style={{ position: 'absolute', left: '0.8rem', top: '0.85rem', color: '#94a3b8' }} />
          </div>

          <button 
            className="btn-editor publish" 
            disabled={isCreatingForm}
            onClick={createForm}
            title="Create a new registration form template"
          >
            {isCreatingForm ? (
              <>
                <FaSpinner className="spin" /> Creating...
              </>
            ) : (
              <>
                <FaPlus /> Create Form
              </>
            )}
          </button>
        </div>

        {/* Template Catalog Grid */}
        <div className="reg-templates-grid">
          {filteredTemplates.map(form => {
            let fieldCount = 0;
            try {
              const parsed = JSON.parse(form.schema);
              fieldCount = countAllFields(parsed.fields || []);
            } catch {
              fieldCount = 0;
            }

            const isLive = form.status === 'LIVE';

            return (
              <div key={form.id} className={`reg-template-card ${isLive ? 'is-live' : ''}`}>
                <div>
                  <div className="reg-card-top">
                    <div className="reg-card-title-area">
                      <h3 className="reg-card-title">{form.name}</h3>
                      <div className="reg-card-meta">
                        <span className="reg-card-meta-item">Version {form.version}</span>
                        <span>•</span>
                        <span className="reg-card-meta-item">{fieldCount} Field{fieldCount === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                    <span className={`reg-status-pill ${form.status.toLowerCase()}`}>
                      {isLive && <span className="reg-pulse-dot" />}
                      {form.status}
                    </span>
                  </div>

                  <p style={{ margin: '0.75rem 0 0 0', fontSize: '0.8rem', color: '#64748b' }}>
                    Created: {new Date(form.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                  </p>
                </div>

                <div className="reg-card-actions">
                  <button 
                    type="button"
                    className="btn-editor preview" 
                    style={{ flex: 1 }} 
                    onClick={() => openForm(form)}
                    title={`Open builder console for ${form.name}`}
                  >
                    <FaEdit /> Edit Form
                  </button>
                  {!isLive && (
                    <button 
                      type="button"
                      className="btn-field-action btn-danger-action" 
                      disabled={deletingFormId === form.id}
                      onClick={() => deleteForm(form.id)}
                      title={`Delete ${form.name}`}
                      aria-label={`Delete ${form.name}`}
                    >
                      {deletingFormId === form.id ? (
                        <FaSpinner className="spin" />
                      ) : (
                        <FaTrash />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
