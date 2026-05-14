// Ordered list of FAQ accordion categories. The "id" is used as both
// the section anchor (e.g. /faq/#medical) and the value stored in each
// FAQ item's `category` frontmatter field.
//
// The "who" and "hypermobility" sections in faq.njk are not in this list
// because they're not Q&A accordion sections — "who" is the persona cards
// and "hypermobility" is article links.
module.exports = [
  {
    id: "general",
    title: "Medical & Coaching Services",
    altClass: "section-alt"
  },
  {
    id: "medical",
    title: "Medical Services",
    altClass: ""
  },
  {
    id: "coaching",
    title: "Coaching Services",
    altClass: "section-alt"
  },
  {
    id: "mentorship",
    title: "Professional Mentorship",
    altClass: ""
  },
  {
    id: "medico-legal",
    title: "Medico-Legal Services",
    altClass: "section-alt"
  }
];
