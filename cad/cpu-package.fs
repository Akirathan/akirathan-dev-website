FeatureScript 3112;
import(path : "onshape/std/common.fs", version : "3112.0");

/**
 * A PGA-style CPU package built from parameters: a substrate with a marked corner, a grid of
 * pins with an empty centre, a row of capacitors along each edge of the lid, and a heat
 * spreader (the lid) with rounded edges. Each part gets a name and a colour, so that a glTF
 * export carries them into a web viewer.
 *
 * Source of truth for the Onshape Feature Studio "CPU Package" in the CPU document. After a
 * change here, paste the whole file into that Feature Studio, then add or regenerate the
 * feature in the Part Studio and export glTF for src/gfx.
 */
annotation { "Feature Type Name" : "CPU Package",
             "Feature Type Description" : "Parametric CPU package: substrate, pin grid, capacitors, and lid." }
export const cpuPackage = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Group Name" : "Package", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Package size" }
            isLength(definition.packageSize, { (millimeter) : [10, 40, 120] } as LengthBoundSpec);
            annotation { "Name" : "Package thickness" }
            isLength(definition.packageThickness, { (millimeter) : [0.5, 1.6, 6] } as LengthBoundSpec);
            annotation { "Name" : "Corner mark width" }
            isLength(definition.cornerMark, { (millimeter) : [0, 2.5, 10] } as LengthBoundSpec);
        }
        annotation { "Group Name" : "Lid", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Lid size" }
            isLength(definition.lidSize, { (millimeter) : [5, 28, 100] } as LengthBoundSpec);
            annotation { "Name" : "Lid height" }
            isLength(definition.lidHeight, { (millimeter) : [0.5, 2.4, 10] } as LengthBoundSpec);
            annotation { "Name" : "Lid edge radius" }
            isLength(definition.lidRadius, { (millimeter) : [0, 0.5, 3] } as LengthBoundSpec);
        }
        annotation { "Group Name" : "Pins", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Pins" }
            definition.hasPins is boolean;
            if (definition.hasPins)
            {
                annotation { "Name" : "Pins per side" }
                isInteger(definition.pinsPerSide, { (unitless) : [2, 26, 60] } as IntegerBoundSpec);
                annotation { "Name" : "Empty centre, pins per side" }
                isInteger(definition.emptyCentre, { (unitless) : [0, 8, 58] } as IntegerBoundSpec);
                annotation { "Name" : "Pin pitch" }
                isLength(definition.pinPitch, { (millimeter) : [0.3, 1.27, 5] } as LengthBoundSpec);
                annotation { "Name" : "Pin diameter" }
                isLength(definition.pinDiameter, { (millimeter) : [0.1, 0.35, 2] } as LengthBoundSpec);
                annotation { "Name" : "Pin length" }
                isLength(definition.pinLength, { (millimeter) : [0.5, 3, 12] } as LengthBoundSpec);
            }
        }
        annotation { "Group Name" : "Traces", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Traces" }
            definition.hasTraces is boolean;
            if (definition.hasTraces)
            {
                annotation { "Name" : "Traces per side" }
                isInteger(definition.tracesPerSide, { (unitless) : [1, 14, 60] } as IntegerBoundSpec);
                annotation { "Name" : "Trace width" }
                isLength(definition.traceWidth, { (millimeter) : [0.05, 0.3, 2] } as LengthBoundSpec);
                annotation { "Name" : "Fan-out" }
                isLength(definition.traceFan, { (millimeter) : [0, 2.5, 10] } as LengthBoundSpec);
                annotation { "Name" : "End markers", "Description" : "A tiny cube named TraceEnd <side> <index> at the end of each trace, for the web page to read." }
                definition.hasMarkers is boolean;
            }
        }
        annotation { "Group Name" : "Capacitors", "Collapsed By Default" : false }
        {
            annotation { "Name" : "Capacitors" }
            definition.hasCapacitors is boolean;
            if (definition.hasCapacitors)
            {
                annotation { "Name" : "Capacitors per edge" }
                isInteger(definition.capsPerEdge, { (unitless) : [1, 7, 40] } as IntegerBoundSpec);
                annotation { "Name" : "Capacitor length" }
                isLength(definition.capLength, { (millimeter) : [0.3, 2, 10] } as LengthBoundSpec);
            }
        }
    }
    {
        const zero = 0 * meter;
        const half = definition.packageSize / 2;
        const thickness = definition.packageThickness;

        // --- Substrate: top face on the XY plane, body below it. --------------------------
        fCuboid(context, id + "substrate", {
                "corner1" : vector(-half, -half, -thickness),
                "corner2" : vector(half, half, zero)
        });
        if (definition.cornerMark > zero)
        {
            // A chamfer on one vertical edge marks pin 1, as on a real package.
            const verticalEdges = qParallelEdges(qCreatedBy(id + "substrate", EntityType.EDGE), vector(0, 0, 1));
            opChamfer(context, id + "cornerMark", {
                    "entities" : qClosestTo(verticalEdges, vector(-half, -half, zero)),
                    "chamferType" : ChamferType.EQUAL_OFFSETS,
                    "width" : definition.cornerMark
            });
        }
        namePart(context, qCreatedBy(id + "substrate", EntityType.BODY), "Substrate", color(0.09, 0.19, 0.16));

        // --- Lid: a block on the substrate with rounded vertical and top edges. ----------
        const lidHalf = definition.lidSize / 2;
        fCuboid(context, id + "lid", {
                "corner1" : vector(-lidHalf, -lidHalf, zero),
                "corner2" : vector(lidHalf, lidHalf, definition.lidHeight)
        });
        if (definition.lidRadius > zero)
        {
            const lidEdges = qCreatedBy(id + "lid", EntityType.EDGE);
            opFillet(context, id + "lidVertical", {
                    "entities" : qParallelEdges(lidEdges, vector(0, 0, 1)),
                    "radius" : definition.lidRadius * 2
            });
            const topFace = qFarthestAlong(qCreatedBy(id + "lid", EntityType.FACE), vector(0, 0, 1));
            opFillet(context, id + "lidTop", {
                    "entities" : qAdjacent(topFace, AdjacencyType.EDGE, EntityType.EDGE),
                    "radius" : definition.lidRadius
            });
        }
        namePart(context, qCreatedBy(id + "lid", EntityType.BODY), "Lid", color(0.72, 0.75, 0.78));

        // --- Pins: one seed pin, patterned over the grid, joined by a thin carrier plate. ---
        if (definition.hasPins)
        {
            const n = definition.pinsPerSide;
            const pitch = definition.pinPitch;
            const centre = (n - 1) / 2;
            const emptyHalf = min(definition.emptyCentre, n - 2) / 2;
            const radius = definition.pinDiameter / 2;
            const carrierThickness = 0.15 * millimeter;

            // Pins overlap the carrier plate a little, so that the union makes one part.
            const pinTop = -thickness - carrierThickness / 2;
            const pinBottom = -thickness - carrierThickness - definition.pinLength;

            var seedPlaced = false;
            var seed = vector(zero, zero);
            var transforms = [];
            var names = [];
            for (var i = 0; i < n; i += 1)
            {
                for (var j = 0; j < n; j += 1)
                {
                    const gx = i - centre;
                    const gy = j - centre;
                    if (abs(gx) < emptyHalf && abs(gy) < emptyHalf)
                        continue;
                    const at = vector(gx * pitch, gy * pitch);
                    if (!seedPlaced)
                    {
                        seed = at;
                        seedPlaced = true;
                        fCylinder(context, id + "pin", {
                                "topCenter" : vector(at[0], at[1], pinTop),
                                "bottomCenter" : vector(at[0], at[1], pinBottom),
                                "radius" : radius
                        });
                    }
                    else
                    {
                        const shift = at - seed;
                        transforms = append(transforms, transform(vector(shift[0], shift[1], zero)));
                        names = append(names, "p" ~ i ~ "_" ~ j);
                    }
                }
            }
            if (size(transforms) > 0)
            {
                opPattern(context, id + "pinPattern", {
                        "entities" : qCreatedBy(id + "pin", EntityType.BODY),
                        "transforms" : transforms,
                        "instanceNames" : names
                });
            }
            const carrierHalf = (centre + 1) * pitch;
            fCuboid(context, id + "carrier", {
                    "corner1" : vector(-carrierHalf, -carrierHalf, -thickness - carrierThickness),
                    "corner2" : vector(carrierHalf, carrierHalf, -thickness)
            });
            const pinBodies = qUnion([
                        qCreatedBy(id + "carrier", EntityType.BODY),
                        qCreatedBy(id + "pin", EntityType.BODY),
                        qCreatedBy(id + "pinPattern", EntityType.BODY)
                    ]);
            opBoolean(context, id + "pinUnion", {
                    "tools" : pinBodies,
                    "operationType" : BooleanOperationType.UNION
            });
            namePart(context, pinBodies, "Pins", color(0.82, 0.66, 0.31));
        }

        // --- Traces: gold fan-out lines on the substrate, like the wiring of a real package. ---
        // A ring sits half under the lid edge. On each side, traces leave the ring outwards,
        // jog by 45 degrees so that they spread out, and run flush to the substrate edge, where
        // the web page can continue them. Each trace is one mitred polygon in a sketch; all are
        // extruded together and joined with the ring into one part.
        if (definition.hasTraces)
        {
            const w = definition.traceWidth;
            const h = 0.08 * millimeter;
            const tid = id + "traces";

            const ringWidth = 0.6 * millimeter;
            const ringInner = lidHalf - ringWidth / 2;
            const ringOuter = lidHalf + ringWidth / 2;
            fCuboid(context, tid + "ringE", { "corner1" : vector(ringInner, -ringOuter, zero), "corner2" : vector(ringOuter, ringOuter, h) });
            fCuboid(context, tid + "ringW", { "corner1" : vector(-ringOuter, -ringOuter, zero), "corner2" : vector(-ringInner, ringOuter, h) });
            fCuboid(context, tid + "ringN", { "corner1" : vector(-ringOuter, ringInner, zero), "corner2" : vector(ringOuter, ringOuter, h) });
            fCuboid(context, tid + "ringS", { "corner1" : vector(-ringOuter, -ringOuter, zero), "corner2" : vector(ringOuter, -ringInner, h) });

            const count = definition.tracesPerSide;
            const fan = definition.traceFan;
            const uStart = ringOuter - w;                   // overlaps the ring
            const uBend = ringOuter + 0.8 * millimeter;     // where the jog starts
            const uEnd = half;                              // flush with the substrate edge
            const vSpan = lidHalf * 0.8;                    // lateral spread at the ring

            // Each trace is drawn along +X (u outwards, v sideways), then turned to its side.
            const sketch = newSketchOnPlane(context, tid + "sketch", {
                    "sketchPlane" : plane(vector(zero, zero, zero), vector(0, 0, 1))
            });
            for (var side = 0; side < 4; side += 1)
            {
                for (var k = 0; k < count; k += 1)
                {
                    const f = count == 1 ? 0 : (k / (count - 1)) * 2 - 1;   // -1 .. 1 along the side
                    const outline = traceOutline(uStart, uBend, uEnd, f * vSpan, f * fan, w);
                    var points = [];
                    for (var corner in outline)
                        points = append(points, turnToSide(corner, side));
                    points = append(points, points[0]);
                    skPolyline(sketch, "trace" ~ side ~ "_" ~ k, { "points" : points });

                    if (definition.hasMarkers)
                    {
                        // A marker part at the end of the trace, on the substrate edge. The
                        // web page reads its position by name, then hides it.
                        const endPoint = turnToSide(vector(uEnd, f * (vSpan + fan)), side);
                        const markerId = tid + ("marker" ~ side ~ "_" ~ k);
                        const r = 0.1 * millimeter;
                        fCuboid(context, markerId, {
                                "corner1" : vector(endPoint[0] - r, endPoint[1] - r, -r),
                                "corner2" : vector(endPoint[0] + r, endPoint[1] + r, r)
                        });
                        namePart(context, qCreatedBy(markerId, EntityType.BODY),
                                 "TraceEnd " ~ side ~ " " ~ (k < 10 ? "0" ~ k : "" ~ k), color(0.66, 0.84, 0.71));
                    }
                }
            }
            skSolve(sketch);
            opExtrude(context, tid + "extrude", {
                    "entities" : qSketchRegion(tid + "sketch"),
                    "direction" : vector(0, 0, 1),
                    "endBound" : BoundingType.BLIND,
                    "endDepth" : h
            });
            opDeleteBodies(context, tid + "deleteSketch", {
                    "entities" : qCreatedBy(tid + "sketch", EntityType.BODY)
            });

            const traceBodies = qUnion([
                        qCreatedBy(tid + "ringE", EntityType.BODY),
                        qCreatedBy(tid + "ringW", EntityType.BODY),
                        qCreatedBy(tid + "ringN", EntityType.BODY),
                        qCreatedBy(tid + "ringS", EntityType.BODY),
                        qCreatedBy(tid + "extrude", EntityType.BODY)
                    ]);
            opBoolean(context, tid + "union", {
                    "tools" : traceBodies,
                    "operationType" : BooleanOperationType.UNION
            });
            namePart(context, traceBodies, "Traces", color(0.85, 0.7, 0.35));
        }

        // --- Capacitors: a row along each edge of the lid, lying on the substrate. ---------
        if (definition.hasCapacitors)
        {
            const count = definition.capsPerEdge;
            const length = definition.capLength;
            const width = length * 0.55;
            const height = length * 0.45;
            const gap = length * 1.4;
            const spacing = length * 1.3;
            const edge = lidHalf + gap;
            const first = -((count - 1) / 2) * spacing;
            var k = 0;
            for (var c = 0; c < count; c += 1)
            {
                const along = first + c * spacing;
                // Front and back edges: the capacitor's long side runs along X.
                for (var sgn in [1, -1])
                {
                    fCuboid(context, id + ("cap" ~ k), {
                            "corner1" : vector(along - length / 2, sgn * edge - width / 2, zero),
                            "corner2" : vector(along + length / 2, sgn * edge + width / 2, height)
                    });
                    k += 1;
                    fCuboid(context, id + ("cap" ~ k), {
                            "corner1" : vector(sgn * edge - width / 2, along - length / 2, zero),
                            "corner2" : vector(sgn * edge + width / 2, along + length / 2, height)
                    });
                    k += 1;
                }
            }
            for (var m = 0; m < k; m += 1)
            {
                namePart(context, qCreatedBy(id + ("cap" ~ m), EntityType.BODY), "Capacitor " ~ (m + 1), color(0.16, 0.17, 0.2));
            }
        }
    }, {
        packageSize : 40 * millimeter,
        packageThickness : 1.6 * millimeter,
        cornerMark : 2.5 * millimeter,
        lidSize : 28 * millimeter,
        lidHeight : 2.4 * millimeter,
        lidRadius : 0.5 * millimeter,
        hasPins : true,
        pinsPerSide : 26,
        emptyCentre : 8,
        pinPitch : 1.27 * millimeter,
        pinDiameter : 0.35 * millimeter,
        pinLength : 3 * millimeter,
        hasTraces : true,
        tracesPerSide : 14,
        traceWidth : 0.3 * millimeter,
        traceFan : 2.5 * millimeter,
        hasMarkers : true,
        hasCapacitors : true,
        capsPerEdge : 7,
        capLength : 2 * millimeter
    });

/**
 * Outline of one trace as a closed polygon, counter-clockwise, in a side's local frame:
 * u runs outwards from the lid, v runs along the side. The centre line goes straight from
 * uStart to uBend, then 45 degrees sideways by `jog`, then straight to uEnd. Corners at the
 * two bends are mitred, so the sides of the trace stay parallel through the bend.
 */
function traceOutline(uStart, uBend, uEnd, v0, jog, w)
{
    const halfW = w / 2;
    if (abs(jog) < w / 4)
    {
        return [vector(uStart, v0 - halfW), vector(uEnd, v0 - halfW),
                vector(uEnd, v0 + halfW), vector(uStart, v0 + halfW)];
    }
    const s = jog > 0 * meter ? 1 : -1;
    const v1 = v0 + jog;
    const uAfter = uBend + abs(jog);
    const p0 = vector(uStart, v0);
    const p1 = vector(uBend, v0);
    const p2 = vector(uAfter, v1);
    const p3 = vector(uEnd, v1);
    // Left normals of the straight legs (n0) and of the diagonal leg (n1); the mitre offset
    // at a bend is the sum of the two normals, scaled so that the width stays w.
    const n0 = vector(0, 1);
    const n1 = vector(-s, 1) / sqrt(2);
    const edge = n0 * halfW;
    const mitre = (n0 + n1) * (halfW / (1 + 1 / sqrt(2)));
    return [p0 + edge, p1 + mitre, p2 + mitre, p3 + edge,
            p3 - edge, p2 - mitre, p1 - mitre, p0 - edge];
}

/** Turns a 2D point from the +X side's frame to the given side (0 = +X, 1 = +Y, 2 = -X, 3 = -Y). */
function turnToSide(p, side)
{
    if (side == 1)
        return vector(-p[1], p[0]);
    if (side == 2)
        return vector(-p[0], -p[1]);
    if (side == 3)
        return vector(p[1], -p[0]);
    return p;
}

/** Gives a body a part name and an appearance colour. */
function namePart(context is Context, body is Query, name is string, appearance is Color)
{
    setProperty(context, { "entities" : body, "propertyType" : PropertyType.NAME, "value" : name });
    setProperty(context, { "entities" : body, "propertyType" : PropertyType.APPEARANCE, "value" : appearance });
}
