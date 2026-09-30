// Why does this file exist? The world compiler's denylist beyond the sources' own names: the real municipalities,
// neighbourhoods, landmarks, waterways and highways of the region a map is modelled on. No fictional name may be one
// of these (region/names.ts NameBook), and a compiled pack is refused if any survives (compile.mjs). It lives with
// the tools, never in the shipped source.
// What breaks if it is removed? A generated compound could land on a real place name ("Meadow" + "vale" is one) and
// nothing would catch it.
export const REAL_PLACES = [
  // Municipalities and former municipalities.
  'Toronto', 'Mississauga', 'Brampton', 'Caledon', 'Markham', 'Vaughan', 'Richmond Hill', 'Aurora', 'Newmarket',
  'King', 'Whitchurch-Stouffville', 'Stouffville', 'East Gwillimbury', 'Georgina', 'Pickering', 'Ajax', 'Whitby',
  'Oshawa', 'Clarington', 'Uxbridge', 'Scugog', 'Brock', 'Oakville', 'Burlington', 'Milton', 'Halton Hills',
  'Georgetown', 'Acton', 'Hamilton', 'Etobicoke', 'Scarborough', 'North York', 'East York', 'York', 'Ontario',
  'Durham', 'Peel', 'Halton', 'Niagara', 'Guelph', 'Kitchener', 'Waterloo', 'Cambridge', 'Barrie', 'Bowmanville',
  // Neighbourhoods.
  'Annex', 'Yorkville', 'Rosedale', 'Cabbagetown', 'Leslieville', 'Riverdale', 'Danforth', 'Greektown', 'Beaches',
  'The Beach', 'Parkdale', 'Roncesvalles', 'Liberty Village', 'Corktown', 'Distillery', 'Regent Park', 'Moss Park',
  'St Lawrence', 'Harbourfront', 'CityPlace', 'Fort York', 'Trinity Bellwoods', 'Little Italy', 'Kensington',
  'Chinatown', 'Queen West', 'Palmerston', 'Seaton Village', 'Christie Pits', 'Dufferin Grove', 'Wychwood',
  'Forest Hill', 'Cedarvale', 'Casa Loma', 'Deer Park', 'Moore Park', 'Summerhill', 'Leaside', 'Davisville',
  'Lawrence Park', 'Bedford Park', 'Willowdale', 'Don Mills', 'Thorncliffe', 'Flemingdon', 'Weston', 'Downsview',
  'Swansea', 'High Park', 'Junction', 'Bloor West', 'Kingsway', 'Mimico', 'New Toronto', 'Long Branch',
  'Alderwood', 'Islington', 'Rexdale', 'Thistletown', 'Humber Bay', 'Agincourt', 'Malvern', 'Rouge', 'Birch Cliff',
  'Cliffside', 'Guildwood', 'West Hill', 'Highland Creek', 'Morningside', 'Woodbridge', 'Maple', 'Kleinburg',
  'Concord', 'Thornhill', 'Oak Ridges', 'Unionville', 'Meadowvale', 'Erin Mills', 'Port Credit', 'Clarkson',
  'Lorne Park', 'Cooksville', 'Streetsville', 'Malton', 'Bramalea', 'Heart Lake', 'Bolton', 'Wexford', 'Dorset Park',
  'Clairlea', 'Oakridge', 'Crescent Town', 'Pape Village', 'Playter Estates', 'Chaplin Estates', 'Hoggs Hollow',
  'York Mills', 'Bayview Village', 'Newtonbrook', 'Steeles', 'Humber Valley', 'Baby Point', 'Lambton', 'Kingsview',
  'Toronto Islands', 'Ward Island', 'Centre Island', 'Hanlan', 'Algonquin Island', 'Olympic Island', 'Ashbridges',
  'Port Lands', 'Villiers', 'Sugar Beach', 'Sherbourne Common', 'Ontario Place', 'Exhibition Place', 'Sunnyside',
  // Waterways and landforms.
  'Lake Ontario', 'Humber', 'Don', 'Don Valley', 'Rouge River', 'Highland Creek', 'Etobicoke Creek', 'Mimico Creek',
  'Credit River', 'Taylor Creek', 'Scarborough Bluffs', 'Bluffers', 'Grenadier Pond', 'Oak Ridges Moraine',
  // Landmarks and venues.
  'CN Tower', 'Rogers Centre', 'SkyDome', 'Scotiabank Arena', 'Air Canada Centre', 'BMO Field', 'Union Station',
  'Royal York', 'Casa Loma', 'Eaton Centre', 'Nathan Phillips', 'Queens Park', 'Ripley', 'Harbourfront Centre',
  'Roy Thomson', 'Massey Hall', 'Budweiser Stage', 'Coca-Cola Coliseum', 'St Lawrence Market', 'Pearson',
  'Billy Bishop', 'Yorkdale', 'Sherway', 'Fairview', 'Scarborough Town Centre', 'Square One',
  // Highways and transit.
  'Gardiner', 'Don Valley Parkway', 'Queen Elizabeth Way', 'QEW', 'Allen Road', 'Highway 401', 'Highway 407',
  'Lake Shore', 'Lakeshore', 'Yonge', 'Bloor', 'Spadina', 'Bathurst', 'Dundas', 'Queen', 'Front', 'Bay', 'University',
  'TTC', 'GO Transit', 'Metrolinx', 'UP Express',
]
