import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const handler = createMcpHandler((server) => {
  // ---------------------------------------------------------------------------
  // Data: Let's Play Music St George
  // ---------------------------------------------------------------------------

  const PROGRAMS = [
    {
      id: "SB",
      name: "Sound Beginnings",
      ageMin: 0,
      ageMax: 4,
      description:
        "Early childhood music class for babies through preschoolers (with caregiver). " +
        "Morning sessions with singing, movement, and instrument exploration. " +
        "Classes run back-to-back (9:30, 10:00, 10:30, 11:00) for flexible scheduling.",
    },
    {
      id: "LPM",
      name: "Let's Play Music",
      ageMin: 4,
      ageMax: 6,
      description:
        "The core Let's Play Music program for ages 4-6. " +
        "A comprehensive musical foundation covering ear training, chord theory, classical music appreciation, " +
        "piano, note reading, and solfege — all in a fun group setting.",
    },
    {
      id: "PR",
      name: "Presto",
      ageMin: 7,
      ageMax: 12,
      description:
        "An accelerated piano class for beginners ages 7-12. " +
        "Students learn appealing repertoire from their very first lesson. Proper piano technique, " +
        "ear training, chord theory, music history, solfege, and composition come together to produce rapid results.",
    },
    {
      id: "GT",
      name: "Guitar",
      ageMin: 7, // TODO: confirm age range
      ageMax: 16, // TODO: confirm age range
      description:
        "Group guitar classes for kids and teens. " +
        "Learn chords, strumming, and songs in a supportive group environment.",
    },
    {
      id: "UK",
      name: "Ukulele",
      ageMin: 5, // TODO: confirm age range
      ageMax: 12, // TODO: confirm age range
      description:
        "Group ukulele classes. " +
        "A fun and accessible introduction to string instruments.",
    },
  ];

  const TEAM = [
    {
      name: "Julie De Rurange",
      role: "Curriculum Head — studio operations and program development",
    },
    {
      name: "Jessica Johnson",
      role: "Curriculum Head — licensed teacher, teacher hiring and training",
    },
    {
      name: "Jessica Clayton",
      role: "Curriculum Head — teaching and curriculum",
    },
  ];

  // Representative class schedule based on the weekly grid.
  // Each entry represents a recurring weekly class.
  const CLASSES = [
    // Monday
    { id: "sb-mon-930", program: "SB", level: null, teacher: "TBD", day: "Monday", time: "9:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-mon-1000", program: "SB", level: null, teacher: "TBD", day: "Monday", time: "10:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-mon-1030", program: "SB", level: null, teacher: "TBD", day: "Monday", time: "10:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-mon-1100", program: "SB", level: null, teacher: "TBD", day: "Monday", time: "11:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-mon-1600-l1", program: "PR", level: "L1", teacher: "De Rurange", day: "Monday", time: "4:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-mon-1700-l2", program: "PR", level: "L2", teacher: "De Rurange", day: "Monday", time: "5:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },

    // Tuesday
    { id: "sb-tue-930", program: "SB", level: null, teacher: "TBD", day: "Tuesday", time: "9:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-tue-1000", program: "SB", level: null, teacher: "TBD", day: "Tuesday", time: "10:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-tue-1030", program: "SB", level: null, teacher: "TBD", day: "Tuesday", time: "10:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "lpm-tue-1530", program: "LPM", level: null, teacher: "Johnson", day: "Tuesday", time: "3:30 PM", ageMin: 4, ageMax: 6, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-tue-1600-l1", program: "PR", level: "L1", teacher: "Johnson", day: "Tuesday", time: "4:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-tue-1700-l3", program: "PR", level: "L3", teacher: "Johnson", day: "Tuesday", time: "5:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },

    // Wednesday
    { id: "sb-wed-930", program: "SB", level: null, teacher: "TBD", day: "Wednesday", time: "9:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-wed-1000", program: "SB", level: null, teacher: "TBD", day: "Wednesday", time: "10:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-wed-1030", program: "SB", level: null, teacher: "TBD", day: "Wednesday", time: "10:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-wed-1100", program: "SB", level: null, teacher: "TBD", day: "Wednesday", time: "11:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-wed-1600-l1", program: "PR", level: "L1", teacher: "Clayton", day: "Wednesday", time: "4:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-wed-1700-l2", program: "PR", level: "L2", teacher: "Clayton", day: "Wednesday", time: "5:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },

    // Thursday
    { id: "sb-thu-930", program: "SB", level: null, teacher: "TBD", day: "Thursday", time: "9:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-thu-1000", program: "SB", level: null, teacher: "TBD", day: "Thursday", time: "10:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-thu-1030", program: "SB", level: null, teacher: "TBD", day: "Thursday", time: "10:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "lpm-thu-1530", program: "LPM", level: null, teacher: "Johnson", day: "Thursday", time: "3:30 PM", ageMin: 4, ageMax: 6, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-thu-1600-l1", program: "PR", level: "L1", teacher: "Johnson", day: "Thursday", time: "4:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-thu-1700-l3", program: "PR", level: "L3", teacher: "Johnson", day: "Thursday", time: "5:00 PM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },

    // Friday
    { id: "gt-fri-1600", program: "GT", level: null, teacher: "TBD", day: "Friday", time: "4:00 PM", ageMin: 7, ageMax: 16, capacity: 10, spotsAvailable: 10, enrollmentUrl: "" },
    { id: "uk-fri-1700", program: "UK", level: null, teacher: "TBD", day: "Friday", time: "5:00 PM", ageMin: 5, ageMax: 12, capacity: 10, spotsAvailable: 10, enrollmentUrl: "" },

    // Saturday
    { id: "sb-sat-930", program: "SB", level: null, teacher: "TBD", day: "Saturday", time: "9:30 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "sb-sat-1000", program: "SB", level: null, teacher: "TBD", day: "Saturday", time: "10:00 AM", ageMin: 0, ageMax: 4, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
    { id: "pr-sat-1100-l1", program: "PR", level: "L1", teacher: "De Rurange", day: "Saturday", time: "11:00 AM", ageMin: 7, ageMax: 12, capacity: 12, spotsAvailable: 12, enrollmentUrl: "" },
  ];

  const CONTACT = {
    businessName: "Let's Play Music St George",
    address: "767 E Hayfield Dr, Washington, UT 84780",
    phone: "", // TODO: add phone number
    email: "", // TODO: add email address
    website: "", // TODO: add website URL
    hours: "Mon-Sat, class hours vary — see schedule", // TODO: confirm hours
    googleMapsUrl: "https://maps.google.com/?q=767+E+Hayfield+Dr+Washington+UT+84780",
    freeTrialUrl: "", // TODO: add free trial booking URL
    emailListUrl: "", // TODO: add email list signup URL
  };

  const PROMOS = [
    // TODO: add promo video links
    // { title: "...", url: "https://youtube.com/...", description: "..." },
  ] as Array<{ title: string; url: string; description: string }>;

  // ---------------------------------------------------------------------------
  // Helper
  // ---------------------------------------------------------------------------

  function programName(id: string): string {
    return PROGRAMS.find((p) => p.id === id)?.name ?? id;
  }

  // ---------------------------------------------------------------------------
  // Tool 1: get_programs
  // ---------------------------------------------------------------------------

  server.tool(
    "get_programs",
    "List all music programs offered by Let's Play Music St George. " +
      "Optionally filter by a child's age to find the right fit.",
    {
      age: z
        .number()
        .int()
        .min(0)
        .max(18)
        .optional()
        .describe("Child's age — returns only programs that match this age"),
    },
    async ({ age }) => {
      let results = PROGRAMS;
      if (age !== undefined) {
        results = results.filter((p) => age >= p.ageMin && age <= p.ageMax);
      }
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: age !== undefined
                ? `No programs currently listed for age ${age}. Contact us for more info!\n\n${CONTACT.businessName}: ${CONTACT.phone || CONTACT.email || CONTACT.address}`
                : "No programs found.",
            },
          ],
        };
      }
      const lines = results.map(
        (p) => `**${p.name}** (${p.id}) — Ages ${p.ageMin}-${p.ageMax}\n${p.description}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `# Programs at ${CONTACT.businessName}\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 2: browse_classes
  // ---------------------------------------------------------------------------

  server.tool(
    "browse_classes",
    "Search and filter the weekly class schedule. " +
      "Filter by program, child's age, day of the week, or teacher name.",
    {
      program: z
        .enum(["SB", "LPM", "PR", "GT", "UK"])
        .optional()
        .describe("Program abbreviation: SB (Sound Beginnings), LPM (Let's Play Music), PR (Presto), GT (Guitar), UK (Ukulele)"),
      age: z
        .number()
        .int()
        .min(0)
        .max(18)
        .optional()
        .describe("Child's age — returns classes whose age range includes this age"),
      day: z
        .enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"])
        .optional()
        .describe("Day of the week"),
      teacher: z
        .string()
        .optional()
        .describe("Teacher last name (e.g. 'De Rurange', 'Johnson', 'Clayton')"),
    },
    async ({ program, age, day, teacher }) => {
      let results = CLASSES;
      if (program) {
        results = results.filter((c) => c.program === program);
      }
      if (age !== undefined) {
        results = results.filter((c) => age >= c.ageMin && age <= c.ageMax);
      }
      if (day) {
        results = results.filter((c) => c.day === day);
      }
      if (teacher) {
        const t = teacher.toLowerCase();
        results = results.filter((c) => c.teacher.toLowerCase().includes(t));
      }
      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No classes match those filters. Try broadening your search or contact us for help!",
            },
          ],
        };
      }
      const lines = results.map((c) => {
        const level = c.level ? ` ${c.level}` : "";
        const spots =
          c.spotsAvailable > 0
            ? `${c.spotsAvailable} spots left`
            : "FULL — join waitlist";
        return `- **${c.day} ${c.time}** — ${programName(c.program)}${level} (ages ${c.ageMin}-${c.ageMax}) | Teacher: ${c.teacher} | ${spots} | ID: \`${c.id}\``;
      });
      return {
        content: [
          {
            type: "text",
            text: `# Class Schedule (${results.length} result${results.length === 1 ? "" : "s"})\n\n${lines.join("\n")}\n\nUse \`get_class_details\` with a class ID for full info, or \`get_enrollment_link\` to sign up.`,
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 3: get_class_details
  // ---------------------------------------------------------------------------

  server.tool(
    "get_class_details",
    "Get full details for a specific class by its ID, including schedule, teacher, age range, and spots available.",
    {
      class_id: z.string().describe("The class ID (e.g. 'pr-tue-1600-l1')"),
    },
    async ({ class_id }) => {
      const cls = CLASSES.find((c) => c.id === class_id);
      if (!cls) {
        return {
          content: [
            {
              type: "text",
              text: `Class "${class_id}" not found. Use \`browse_classes\` to see available classes.`,
            },
          ],
        };
      }
      const prog = PROGRAMS.find((p) => p.id === cls.program);
      const level = cls.level ? `Level: ${cls.level}\n` : "";
      const spots =
        cls.spotsAvailable > 0
          ? `${cls.spotsAvailable} of ${cls.capacity} spots available`
          : "FULL — contact us to join the waitlist";
      const enrollment = cls.enrollmentUrl
        ? `Enroll: ${cls.enrollmentUrl}`
        : "Enrollment link coming soon — contact us to reserve a spot!";

      return {
        content: [
          {
            type: "text",
            text: [
              `# ${programName(cls.program)}${cls.level ? " " + cls.level : ""} — ${cls.day} ${cls.time}`,
              "",
              `Program: ${prog?.name ?? cls.program}`,
              level + `Ages: ${cls.ageMin}-${cls.ageMax}`,
              `Day: ${cls.day}`,
              `Time: ${cls.time}`,
              `Teacher: ${cls.teacher}`,
              `Availability: ${spots}`,
              "",
              prog?.description ?? "",
              "",
              enrollment,
              "",
              `Location: ${CONTACT.address}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 4: get_contact_and_location
  // ---------------------------------------------------------------------------

  server.tool(
    "get_contact_and_location",
    "Get contact information and studio location for Let's Play Music St George.",
    {},
    async () => {
      const lines = [
        `# ${CONTACT.businessName}`,
        "",
        `Address: ${CONTACT.address}`,
        CONTACT.phone ? `Phone: ${CONTACT.phone}` : "",
        CONTACT.email ? `Email: ${CONTACT.email}` : "",
        CONTACT.website ? `Website: ${CONTACT.website}` : "",
        `Hours: ${CONTACT.hours}`,
        "",
        `Google Maps: ${CONTACT.googleMapsUrl}`,
        "",
        "## Our Team",
        ...TEAM.map((t) => `- **${t.name}** — ${t.role}`),
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 5: get_enrollment_link
  // ---------------------------------------------------------------------------

  server.tool(
    "get_enrollment_link",
    "Get the enrollment/signup link for a specific class, along with availability.",
    {
      class_id: z.string().describe("The class ID (e.g. 'pr-tue-1600-l1')"),
    },
    async ({ class_id }) => {
      const cls = CLASSES.find((c) => c.id === class_id);
      if (!cls) {
        return {
          content: [
            {
              type: "text",
              text: `Class "${class_id}" not found. Use \`browse_classes\` to see available classes.`,
            },
          ],
        };
      }
      const spots =
        cls.spotsAvailable > 0
          ? `${cls.spotsAvailable} of ${cls.capacity} spots available — enroll soon!`
          : "This class is currently FULL. Contact us to join the waitlist.";
      const link = cls.enrollmentUrl
        ? `Enroll here: ${cls.enrollmentUrl}`
        : "Enrollment link coming soon! Contact us to reserve your spot.";
      const contact = CONTACT.phone
        ? `Phone: ${CONTACT.phone}`
        : CONTACT.email
          ? `Email: ${CONTACT.email}`
          : `Visit us: ${CONTACT.address}`;

      return {
        content: [
          {
            type: "text",
            text: [
              `# Enroll in ${programName(cls.program)}${cls.level ? " " + cls.level : ""} — ${cls.day} ${cls.time}`,
              "",
              spots,
              "",
              link,
              "",
              contact,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Tool 6: get_free_trial_info
  // ---------------------------------------------------------------------------

  server.tool(
    "get_free_trial_info",
    "Get information about booking a free trial class and joining the email list for Let's Play Music St George.",
    {},
    async () => {
      const trialLine = CONTACT.freeTrialUrl
        ? `Book your free trial class: ${CONTACT.freeTrialUrl}`
        : "Free trial classes available! Contact us to schedule yours.";
      const emailLine = CONTACT.emailListUrl
        ? `Join our email list for updates: ${CONTACT.emailListUrl}`
        : "Ask us about joining our email list for class openings and events!";
      const contact = CONTACT.phone
        ? `Phone: ${CONTACT.phone}`
        : CONTACT.email
          ? `Email: ${CONTACT.email}`
          : `Visit us: ${CONTACT.address}`;

      return {
        content: [
          {
            type: "text",
            text: [
              `# Try a Free Class at ${CONTACT.businessName}!`,
              "",
              "Not sure if Let's Play Music is right for your family? Come try a class for free!",
              "",
              trialLine,
              "",
              emailLine,
              "",
              `Location: ${CONTACT.address}`,
              contact,
              "",
              "We offer programs for ages 0-12+:",
              ...PROGRAMS.map((p) => `- **${p.name}** — ages ${p.ageMin}-${p.ageMax}`),
            ].join("\n"),
          },
        ],
      };
    },
  );
});

export { handler as GET, handler as POST, handler as DELETE };
