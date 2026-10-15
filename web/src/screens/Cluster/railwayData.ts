/**
 * Fallback copy of the Indian Railways Zone -> Division reference data.
 * The app normally fetches this from `GET /api/v1/lcgate/reference-data`;
 * this constant is used if that request fails so the dropdowns still work.
 */
export const RAILWAY_DATA: Record<string, string[]> = {
  'Central Railway': ['Mumbai CST', 'Bhusawal', 'Pune', 'Solapur', 'Nagpur CR'],
  'Western Railway': ['Ratlam', 'Mumbai Central', 'Vadodara', 'Ahmedabad', 'Rajkot', 'Bhavnagar'],
  'Northern Railway': ['Delhi', 'Ambala', 'Firozpur', 'Lucknow NR', 'Moradabad'],
  'North Central Railway': ['Prayagraj', 'Agra', 'Jhansi'],
  'North Western Railway': ['Jaipur', 'Ajmer', 'Bikaner', 'Jodhpur'],
  'West Central Railway': ['Jabalpur', 'Bhopal', 'Kota'],
  'Eastern Railway': ['Howrah', 'Sealdah', 'Asansol', 'Malda'],
  'East Central Railway': [
    'Danapur',
    'Pt. Deen Dayal Upadhyaya',
    'Dhanbad',
    'Samastipur',
    'Sonpur',
  ],
  'North Eastern Railway': ['Lucknow NER', 'Izzatnagar', 'Varanasi'],
  'Northeast Frontier Railway': ['Lumding', 'Katihar', 'Alipurduar', 'Rangiya', 'Tinsukia'],
  'South Central Railway': ['Secunderabad', 'Hyderabad', 'Nanded'],
  'Southern Railway': [
    'Chennai',
    'Tiruchirappalli',
    'Madurai',
    'Palakkad',
    'Salem',
    'Thiruvananthapuram',
  ],
  'South Western Railway': ['Hubballi', 'Bengaluru', 'Mysuru'],
  'South Eastern Railway': ['Kharagpur', 'Chakradharpur', 'Adra', 'Ranchi'],
  'South East Central Railway': ['Bilaspur', 'Raipur', 'Nagpur SEC'],
  'East Coast Railway': ['Khurda Road', 'Sambalpur', 'Rayagada'],
  'South Coast Railway': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Guntakal'],
  'Konkan Railway': ['Ratnagiri', 'Karwar'],
  'Kolkata Metro Railway': ['Headquarters'],
};

export const RAILWAY_ZONES: string[] = Object.keys(RAILWAY_DATA);

export const divisionsForZone = (zone?: string | null): string[] => {
  if (!zone) return [];
  const normalized = zone.trim().toLowerCase().replace(/s$/, '');
  const key = Object.keys(RAILWAY_DATA).find((z) => {
    const normZ = z.toLowerCase().replace(/s$/, '');
    return normZ === normalized || normalized.includes(normZ) || normZ.includes(normalized);
  });
  return key ? RAILWAY_DATA[key] : [];
};