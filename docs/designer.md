# Designer System

The Designer is the central subsystem of Partshelf.

Its purpose is to bridge the gap between CAD and the physical world by transforming assemblies imported from Onshape into actionable manufacturing, purchasing, and inventory workflows.

Unlike a traditional CAD viewer or inventory manager, the Designer understands **how parts relate to one another**. It allows users to visualize assemblies, determine which parts are already available, identify what must be fabricated or ordered, and ultimately prepare an assembly for physical assembling.

---

# Purpose

The Designer exists to answer one simple question:

> **"Can we build this assembly today?"**

To answer that question, the Designer combines information from four independent systems:

```
Onshape Assembly

↓

Assembly Structure

↓

Inventory

Fabrication

Part Orders

↓

Assembly Readiness
```

Rather than forcing users to manually compare a Bill of Materials against inventory, Partshelf performs this reconciliation automatically.

---

# Design Philosophy

The Designer follows several guiding principles.

## CAD is the Source of Truth

Assembly structure originates from CAD.

Users should never manually recreate Bills of Materials that already exist in Onshape.

Whenever possible, assemblies should be imported directly rather than rebuilt by hand.

---

## Assemblies Describe Intent

Assemblies represent how things should be built.

They do not represent inventory.

They do not represent fabrication.

They simply describe the desired finished product.

This distinction allows the same Assembly to be reused regardless of current inventory levels.

---

## Separate Requirements from Availability

The Designer intentionally separates two questions.

"What does this assembly require?"

and

"What do we currently have?"

Assembly data answers the first.

Inventory answers the second.

Keeping these concerns separate makes inventory changes immediately visible without modifying the assembly itself.

---

## Minimize Manual Work

The Designer should automate repetitive tasks whenever possible.

Examples include:

- Importing Bills of Materials directly from Onshape.
- Detecting newly required fabricated parts.
- Generating purchase requests.
- Identifying missing inventory.
- Updating build readiness.

Users should spend time building—not maintaining spreadsheets.

---

# Assembly Model

Assemblies are hierarchical.

Every Assembly consists of:

- Components
- Child Assemblies

This allows complex designs to be represented recursively.

Example:

```
Car

├── Drivetrain
│   ├── Gearbox
│   ├── Wheel
│   └── Engine
│
├── Interior
│   ├── Center Console
│   ├── Steering Wheel
│   └── Seats
│
└── AC system
```

There is no fixed hierarchy depth.

Assemblies may contain any number of nested Assemblies.

---

# Components vs Assemblies

Understanding the distinction between Components and Assemblies is critical.

A Component represents one physical part.

Examples:

- Bearing
- Bolt
- Plate
- Motor

An Assembly represents a collection of Components.

Examples:

- Gearbox
- Turbocharger
- Brakes

Assemblies may contain other Assemblies.

Components may not.

---

# Assembly Parts

Assembly Parts describe requirements.

For example:

```
Gearbox

↓

Requires

↓

2 Bearings

4 Bolts

1 Plate
```

Assembly Parts do not represent inventory.

Instead, they describe what must eventually exist.

Each requirement is later satisfied by one of three workflows.

---

# Satisfying Requirements

Every Assembly Part eventually becomes one of three things.

## Existing Inventory

The required Component already exists.

```
Assembly

↓

Inventory Match

↓

Ready
```

No additional work is required.

---

## Fabrication

The required Component is custom manufactured.

```
Assembly

↓

Custom Plate

↓

Fabrication Job

↓

Finished Inventory
```

Once manufactured, the resulting inventory satisfies the requirement.

---

## Purchase

The required Component is commercially available.

```
Assembly

↓

Vendor Part

↓

Purchase Order

↓

Received Inventory
```

Purchased inventory satisfies the requirement in exactly the same way as fabricated inventory.

---

# Bill of Materials

The Designer generates a Bill of Materials (BOM) from the Assembly hierarchy.

Unlike a flat BOM exported directly from CAD, Partshelf augments the data with logistics information.

Each line may include:

- Component
- Quantity
- Inventory Status
- Fabrication Status
- Purchase Status
- Build Readiness

The BOM therefore becomes both a manufacturing document and a planning document.

---

# Build Readiness

One of the primary responsibilities of the Designer is determining whether an Assembly can currently be built.

Each required Component is evaluated.

Possible outcomes include:

```
Available

Needs Fabrication

Needs Purchase

Reserved

Unavailable
```

The overall Assembly readiness is then derived from the readiness of all required Components.

---

# Onshape Integration

Assemblies originate primarily from Onshape.

The import process generally follows this workflow.

```
Select Assembly

↓

Import BOM

↓

Resolve Components

↓

Create Assembly

↓

Analyze Requirements

↓

Generate Fabrication & Purchasing Tasks
```

The imported Assembly becomes independent from Onshape after synchronization.

Future synchronization updates only changed information rather than recreating the entire Assembly whenever possible.

---

# Relationship to Inventory

Inventory does not own Assemblies.

Assemblies reference Components.

Inventory references Components.

Because both systems share the same Component definitions, inventory updates immediately affect Assembly readiness without modifying Assembly data.

```
Assembly

↓

Component

↑

Inventory
```

This shared reference model avoids duplicated information.

---

# Relationship to Fabrication

Fabrication Jobs originate from Assembly requirements.

The Designer identifies Components that:

- do not exist in inventory
- are custom manufactured
- require production

These Components become Fabrication Jobs.

Once completed:

```
Fabrication Job

↓

Inventory Instance

↓

Assembly Ready
```

No manual relinking is required.

---

# Relationship to Part Orders

Purchased Components follow an analogous workflow.

```
Assembly Requirement

↓

Vendor Item

↓

Cart

↓

Purchase

↓

Receive Inventory

↓

Assembly Ready
```

This allows purchasing to begin directly from assembly requirements.

---

# Typical Workflow

A typical workflow within Partshelf is:

```
Create CAD Assembly

↓

Import into Partshelf

↓

Resolve Components

↓

Review Assembly

↓

Identify Missing Parts

↓

Create Fabrication Jobs

↓

Create Purchase Requests

↓

Receive Inventory

↓

Build Assembly
```

This workflow represents the primary purpose of the Designer.

---

# Guiding Principles

## Assemblies should never duplicate inventory.

Assemblies describe intent.

Inventory describes availability.

---

## Assemblies should remain CAD-centric.

Users should not manually rebuild information that already exists in CAD.

---

## Components should be reusable.

One Component may appear in many Assemblies.

Updating the Component updates every Assembly automatically.

---

## Build status should be derived.

Readiness should always be calculated from current inventory, fabrication, and purchasing data.

It should never be manually maintained.

---

## Automation should replace repetitive work.

The Designer should reduce manual effort whenever possible.

Users should spend their time designing and assembling things rather than maintaining logistics data.

---

# Future Direction

The Designer is intended to become the operational center of Partshelf.

Future enhancements may include:

- Assembly version comparison
- Change detection between CAD revisions
- Drag-and-drop assembly editing
- Automatic inventory reservation
- Assembly cost estimation
- Weight estimation
- Manufacturing lead-time prediction
- Assembly instructions
- Build sequencing
- Dependency visualization
- Revision history

These additions all build upon the same underlying philosophy:

> **The Designer should transform CAD data into everything required to physically build a design.**

As Partshelf evolves, the Designer should remain responsible for connecting design, inventory, manufacturing, and purchasing while minimizing manual work and maintaining a single source of truth.