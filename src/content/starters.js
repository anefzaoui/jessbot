// Built-in starter content for new users (fights "blank canvas syndrome" — transcript T1).
// Examples come from the Muse transcripts, adapted. This is product copy, not demo data.

export const CHAT_SUGGESTIONS = [
  { label: 'Find me a table at a Greek restaurant nearby for Friday', text: 'Find me a table for two at a good Greek restaurant near me this Friday around 8pm.', iconName: 'utensils' },
  { label: 'Plan a weekend away with the family', text: 'Help me plan a weekend away with my family next month. Ask me what you need to know.', iconName: 'map' },
  { label: 'Brief me every morning on what matters', text: 'Every weekday at 7am, brief me on the news I care about. Ask me what topics.', iconName: 'sunrise' },
  { label: 'Research me and build a page about who I am', text: 'Research me online and build a one-page site about who I am and what I do.', iconName: 'user-round-search' },
];

// prompt: what "Let's do it" sends to Jess in the main chat.
export const STARTER_IDEAS = [
  { id: 'starter-brief', title: 'A morning brief that replaces doom-scrolling', why: 'I read the sources you pick and write you a short brief each morning — so you spend less time on social media.', prompt: "I'd like a short news brief each morning instead of scrolling social media. Ask me which topics and sources I care about, then set it up in my Feed.", category: 'Daily life', iconName: 'sunrise' },
  { id: 'starter-deals', title: 'Watch Marketplace for a deal', why: "Tell me what you're hunting for and your price. I'll keep checking listings and ping you when something good shows up.", prompt: "Help me hunt for a deal. Ask me what I'm looking for, where to look and my price limit, then check listings for me and tell me when something good shows up.", category: 'Shopping', iconName: 'tag' },
  { id: 'starter-tickets', title: 'Get movie tickets in one message', why: 'Tell me the film, the night and the cinema. I compare showtimes and hold seats — you just approve the purchase.', prompt: "I want to see a film. Ask me which one, which night and which cinema, then compare showtimes and tell me the best options.", category: 'Errands', iconName: 'ticket' },
  { id: 'starter-bills', title: 'Negotiate a bill down', why: "Share a bill that feels too high. I'll research fair prices and draft what to say — or handle it for you.", prompt: "One of my bills feels too high. Ask me which one and what I pay, research what's fair, and draft what I should say to get it down.", category: 'Money', iconName: 'badge-dollar-sign' },
  { id: 'starter-about-me', title: 'A page about you, built from the web', why: "I'll research your public footprint and turn it into a clean one-page site — useful for bios, intros and job hunting.", prompt: "Research me online (ask me my full name and anything that helps you find the right person), then build a clean one-page site about who I am and what I do.", category: 'Work', iconName: 'user-round-search' },
  { id: 'starter-goal', title: 'Turn a goal into a plan', why: "Name something you want — I'll ask a few questions, show you everything I can do, and keep at it in the background.", prompt: "Help me turn something I want into a plan. Ask me what it is, then take me to set it up as a goal.", category: 'Goals', iconName: 'target' },
];

export const GOAL_CATEGORIES = [
  { value: 'health', label: 'Health', hue: 155 },
  { value: 'money', label: 'Money', hue: 85 },
  { value: 'career', label: 'Career', hue: 250 },
  { value: 'family', label: 'Family & friends', hue: 20 },
  { value: 'home', label: 'Home', hue: 45 },
  { value: 'learning', label: 'Learning', hue: 300 },
  { value: 'creative', label: 'Creative', hue: 330 },
];

export const GOAL_EXAMPLES = [
  'Grow my creator business on LinkedIn',
  'Get back into running — 5k by spring',
  'Cut our monthly spending by 10%',
  'Read 20 books this year',
  'Plan a stress-free kid’s birthday party',
];
