/// Fallback copy of the Indian Railways Zone -> Division reference data.
///
/// The app normally fetches this from `GET $baseUrl/lcgate/reference-data`;
/// this constant is used if that request fails so the dropdowns still work.
class RailwayData {
  static const Map<String, List<String>> data = {
    'Central Railway': ['Mumbai CST', 'Bhusawal', 'Pune', 'Solapur', 'Nagpur CR'],
    'Western Railway': ['Ratlam', 'Mumbai Central', 'Vadodara', 'Ahmedabad', 'Rajkot', 'Bhavnagar'],
    'Northern Railway': ['Delhi', 'Ambala', 'Firozpur', 'Lucknow NR', 'Moradabad'],
    'North Central Railway': ['Prayagraj', 'Agra', 'Jhansi'],
    'North Western Railway': ['Jaipur', 'Ajmer', 'Bikaner', 'Jodhpur'],
    'West Central Railway': ['Jabalpur', 'Bhopal', 'Kota'],
    'Eastern Railway': ['Howrah', 'Sealdah', 'Asansol', 'Malda'],
    'East Central Railway': ['Danapur', 'Pt. Deen Dayal Upadhyaya', 'Dhanbad', 'Samastipur', 'Sonpur'],
    'North Eastern Railway': ['Lucknow NER', 'Izzatnagar', 'Varanasi'],
    'Northeast Frontier Railway': ['Lumding', 'Katihar', 'Alipurduar', 'Rangiya', 'Tinsukia'],
    'South Central Railway': ['Secunderabad', 'Hyderabad', 'Nanded'],
    'Southern Railway': ['Chennai', 'Tiruchirappalli', 'Madurai', 'Palakkad', 'Salem', 'Thiruvananthapuram'],
    'South Western Railway': ['Hubballi', 'Bengaluru', 'Mysuru'],
    'South Eastern Railway': ['Kharagpur', 'Chakradharpur', 'Adra', 'Ranchi'],
    'South East Central Railway': ['Bilaspur', 'Raipur', 'Nagpur SEC'],
    'East Coast Railway': ['Khurda Road', 'Sambalpur', 'Rayagada'],
    'South Coast Railway': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Guntakal'],
    'Konkan Railway': ['Ratnagiri', 'Karwar'],
    'Kolkata Metro Railway': ['Headquarters'],
  };

  static List<String> get zones => data.keys.toList();

  static List<String> divisionsForZone(String? zone) {
    if (zone == null || zone.trim().isEmpty) return [];
    final normalized = zone.trim().toLowerCase().replaceAll(RegExp(r's$'), '');
    final key = data.keys.firstWhere(
      (z) {
        final normZ = z.toLowerCase().replaceAll(RegExp(r's$'), '');
        return normZ == normalized || normalized.contains(normZ) || normZ.contains(normalized);
      },
      orElse: () => '',
    );
    if (key.isEmpty) return [];
    return data[key] ?? [];
  }

  static bool hasDivisions(String? zone) => divisionsForZone(zone).isNotEmpty;
}