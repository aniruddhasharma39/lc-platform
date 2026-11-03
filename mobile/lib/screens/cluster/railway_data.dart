/// Fallback copy of the Indian Railways Zone -> Division -> Station reference data.
///
/// The app normally fetches this from `GET $baseUrl/lcgate/reference-data`;
/// this constant is used if that request fails so the dropdowns still work.
class StationReference {
  final String code;
  final String name;
  const StationReference({required this.code, required this.name});
}

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

  static const Map<String, List<StationReference>> stations = {
    'Pune': [
      StationReference(code: 'PUNE', name: 'Pune Junction'),
      StationReference(code: 'SVJR', name: 'Shivajinagar'),
      StationReference(code: 'KK', name: 'Khadki'),
      StationReference(code: 'DAPD', name: 'Dapodi'),
      StationReference(code: 'KSWD', name: 'Kasarwadi'),
      StationReference(code: 'PMP', name: 'Pimpri'),
      StationReference(code: 'CCH', name: 'Chinchwad'),
      StationReference(code: 'AKRD', name: 'Akurdi'),
      StationReference(code: 'DEHR', name: 'Dehu Road'),
      StationReference(code: 'BGWI', name: 'Begdewadi'),
      StationReference(code: 'GRWD', name: 'Ghorawadi'),
      StationReference(code: 'TGN', name: 'Talegaon'),
      StationReference(code: 'VDN', name: 'Vadgaon'),
      StationReference(code: 'KNHE', name: 'Kanhe'),
      StationReference(code: 'KMST', name: 'Kamshet'),
      StationReference(code: 'MVL', name: 'Malavli'),
      StationReference(code: 'LNL', name: 'Lonavala'),
      StationReference(code: 'HDP', name: 'Hadapsar'),
      StationReference(code: 'URI', name: 'Uruli'),
      StationReference(code: 'DD', name: 'Daund Junction'),
      StationReference(code: 'STR', name: 'Satara'),
      StationReference(code: 'MRJ', name: 'Miraj Junction'),
      StationReference(code: 'KOP', name: 'Kolhapur CSMT'),
    ],
    'Mumbai CST': [
      StationReference(code: 'CSMT', name: 'Chhatrapati Shivaji Maharaj Terminus'),
      StationReference(code: 'BY', name: 'Byculla'),
      StationReference(code: 'DR', name: 'Dadar Central'),
      StationReference(code: 'CLA', name: 'Kurla'),
      StationReference(code: 'GC', name: 'Ghatkopar'),
      StationReference(code: 'TNA', name: 'Thane'),
      StationReference(code: 'DIVA', name: 'Diva Junction'),
      StationReference(code: 'KYN', name: 'Kalyan Junction'),
      StationReference(code: 'PNVL', name: 'Panvel Junction'),
      StationReference(code: 'IGP', name: 'Igatpuri'),
      StationReference(code: 'KJT', name: 'Karjat'),
      StationReference(code: 'ROHA', name: 'Roha'),
    ],
    'Bhusawal': [
      StationReference(code: 'BSL', name: 'Bhusawal Junction'),
      StationReference(code: 'JL', name: 'Jalgaon Junction'),
      StationReference(code: 'NK', name: 'Nashik Road'),
      StationReference(code: 'MMR', name: 'Manmad Junction'),
      StationReference(code: 'CSN', name: 'Chalisgaon'),
      StationReference(code: 'BAU', name: 'Burhanpur'),
      StationReference(code: 'KNW', name: 'Khandwa Junction'),
      StationReference(code: 'AK', name: 'Akola Junction'),
      StationReference(code: 'BD', name: 'Badnera Junction'),
    ],
    'Delhi': [
      StationReference(code: 'NDLS', name: 'New Delhi'),
      StationReference(code: 'DLI', name: 'Old Delhi'),
      StationReference(code: 'NZM', name: 'Hazrat Nizamuddin'),
      StationReference(code: 'ANVT', name: 'Anand Vihar Terminal'),
      StationReference(code: 'DEE', name: 'Delhi Sarai Rohilla'),
      StationReference(code: 'GZB', name: 'Ghaziabad Junction'),
      StationReference(code: 'MTC', name: 'Meerut City'),
      StationReference(code: 'PNP', name: 'Panipat Junction'),
      StationReference(code: 'SNP', name: 'Sonipat'),
      StationReference(code: 'ROK', name: 'Rohtak Junction'),
    ],
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

  static List<StationReference> stationsForDivision(String? division) {
    if (division == null || division.trim().isEmpty) return [];
    final key = stations.keys.firstWhere(
      (d) => d.toLowerCase() == division.trim().toLowerCase(),
      orElse: () => '',
    );
    if (key.isNotEmpty) return stations[key] ?? [];

    final codePrefix = division.length >= 3 ? division.substring(0, 3).toUpperCase() : division.toUpperCase();
    return [
      StationReference(code: '$codePrefix-01', name: '$division Main Station'),
      StationReference(code: '$codePrefix-02', name: '$division Junction'),
    ];
  }

  static bool hasDivisions(String? zone) => divisionsForZone(zone).isNotEmpty;
}
