# Partshelf

## Goal: create a centralized logistics hub for tracking inventory parts, Onshape assemblies, fabrication jobs, and part orders. The user base is pretty small, at around 25 people, and parts are limited in scope; either COTS parts or custom machined parts, which fall under the categories of custom spacers, custom shafts, and custom plates. At some point, the system will also expand to incorporate users in a more direct way: including an agenda, tasks, and assignments for project management. This will replace spreadsheets, hand drawings, and memory with a single system.


## Philosophy: The system should be easy to use, balancing the act of requiring minimum input from the user with the act of respecting users' data and choices. The system should comprehensively cover every single part of the timeline from CAD to a finished assembly, otherwise users will go back to using multiple systems alongside partshelf therefore defeating the goal and purpose.

## System Diagram: Onshape --> Assembly Import --> Designer workflow --> Link existing inventory parts to the assembly, send custom parts to fabrication, order COTS parts --> Assemblying in real life

## Essential relationships - These definitions may omit small details in the interest of clarity

Categories - an adjective for components and inventory instances (defined below) that describe the larger class a part belongs to. Examples include Gears, Pulleys, Belts, Bolts. Each category can define required attributes that each child component in that category must populate. A Bolt category, for example, could have required attributes of "Thread size," "bolt length," and "head type."

Components - Abstraction of real-life parts that may or may not fall under a category. Components are identified by their attributes and category, but NOT by name. To give an example, a bolt with a 1/4-20 thread, 2" length, and socket head drive represents a unique component.

Inventory Instances - instances of Components that exist in real life. Each inventory instance has both a location and quantity, and is directly linked to a Component. For example, the C1 bin could contain 5 1/4-20 thread, 2" length, socket head drive bolts. 

Fabrication Jobs - sometimes, we may need something that isn't in the inventory. Fabrication Jobs are a way to PROMISE a quantity of a certain component, allowing us to track fabrication status + other things. 

Cart items - For the COTS parts that we want to buy. Similar to fabrication jobs, in that a quantity can be PROMISED and status can be tracked.

Assembly Parts - BOM items, usually directly linked to Onshape Assemblies. To collect BOM items and satisfy the quantity needed, users can either link existing inventory instances to BOM line items, send BOM items to fabricate, or send BOM items to the cart to buy. In all three cases, assembly parts are looking for a certain component that exists in inventory, or will exist via fabrication or purchasing, in the real world.

The components abstraction is essential to this program. 


## Major Systems

Inventory:
Lets users create, edit, and delete inventory instances. Users can also create, delete, and edit categories.

Designer:
Users start by creating assemblies, which in reality is just assembly BOMs. Users import BOMs from Onshape. Sometimes, assemblies can contain child assemblies (ie. an engine contains 8 pistons, and each piston is a child assembly with rods, bolts, piston heads, bearings, etc) which are treated as their own assembly within the parent assembly that users must also gather parts for. From there, all parts need to be collected through 3 avenues: linking inventory instances to BOM lines, sending parts to be fabricated, or sending COTS parts to be ordered.

Fabricate:
This system displays all the fabrication jobs created in the designer system. Each fabrication job has a quantity, and multiple fabrication jobs can be grouped together into "batches." For example, 2 one-inch spacers and 2 three-inch spacers could be batched and manufactured together. Then, users can claim fabrication jobs/batches.

Part Orders:
When BOM COTS parts are sent to be ordered, they are grouped by vendor. Each vendor has a "cart" that contains all its orders (ie. a McMaster-carr cart contains all McMaster Parts)

##Repo Structure
src/ 
Frontend application, contains designer, fabrication, inventory, part orders, and UI
----------------------------------------------------------------------------------------------
api/ 
Serverless API endpoints primarily used for accessing Onshape functions
------------------------------------------------------------------------------------
_lib/
shared backend utilities
------------------------------------------------------------------------------------
docs/
project documentation
------------------------------------------------------------------------------------
fixes/
engineering roadmap
------------------------------------------------------------------------------------

## Documentation guide
README.md - project overview
docs/ARCHITECTURE.md - overall architecture
docs/DATABASE.md - Database schema
docs/DESIGNER.md - Assembly system
fixes/TODO.md - Prioritized engineering backlog
fixes/architecture/*.md - detailed refactor designs

If you want to understand the project, I suggest you read the docs in this order: 
1. README.md
2. ARCHITECTURE.md
3.DATABASE.md
4. DESIGNER.md
5. API.md