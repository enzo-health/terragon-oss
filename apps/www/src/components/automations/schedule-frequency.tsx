"use client";

import {
  ScheduleFrequency,
  parseCronToState,
  generateCron,
  getCronDescription,
  getNextRunTime,
  validateCronExpression,
} from "@terragon/shared/automations/cron";
import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { FormLabel } from "@/components/ui/form";
import { Combobox } from "@/components/ui/combobox";
import { ResponsiveCombobox } from "@/components/ui/responsive-combobox";
import {
  Select,
  SelectItem,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScheduleTriggerConfig } from "@terragon/shared/automations";
import { MAX_HOURS_SCHEDULE_AUTOMATIONS } from "@terragon/shared/automations/cron";

export function ScheduleTriggerForm({
  value,
  onChange,
}: {
  value: ScheduleTriggerConfig;
  onChange: (value: ScheduleTriggerConfig) => void;
}) {
  const tier = "pro" as const;
  const initialState = useMemo(
    () => parseCronToState(value.cron),
    [value.cron],
  );
  const [frequency, setFrequency] = useState<ScheduleFrequency>(
    initialState.frequency,
  );
  const [hours, setHours] = useState<string[]>(
    initialState.selectedHours && initialState.selectedHours.length > 0
      ? initialState.selectedHours
          .map((h) => h.split(":")[0])
          .filter((h): h is string => h !== undefined)
      : [initialState.hour?.split(":")[0] ?? "9"],
  );
  const [minutes, setMinutes] = useState(
    initialState.hour?.split(":")[1] || "00",
  );
  const [dayOfWeek, setDayOfWeek] = useState(initialState.dayOfWeek || "1");
  const [dayOfMonth, setDayOfMonth] = useState(initialState.dayOfMonth || "1");
  const [selectedDays, setSelectedDays] = useState<string[]>(
    initialState.selectedDays || [],
  );
  const [showMultipleHoursInput, setShowMultipleHoursInput] = useState(
    (initialState.selectedHours || []).length > 1,
  );
  const [hoursInputValue, setHoursInputValue] = useState(hours.join(", "));
  const [hoursInputError, setHoursInputError] = useState<string | null>(null);

  const updateCron = (
    newFrequency: ScheduleFrequency = frequency,
    newHours: string[] = hours,
    newMinutes: string = minutes,
    newDayOfWeek: string = dayOfWeek,
    newDayOfMonth: string = dayOfMonth,
    newSelectedDays: string[] = selectedDays,
  ) => {
    // If multiple hours, use them all; otherwise use single hour
    const selectedHours =
      newHours.length > 1 ? newHours.map((h) => `${h}:${newMinutes}`) : [];
    const singleHour =
      newHours.length === 1 ? `${newHours[0]}:${newMinutes}` : "9:00";

    const cron = generateCron(
      newFrequency,
      singleHour,
      newDayOfWeek,
      newDayOfMonth,
      newSelectedDays,
      selectedHours,
    );
    onChange({ ...value, cron });
  };

  const { isValid, error } = validateCronExpression(value.cron, {
    accessTier: tier,
  });
  return (
    <div className="space-y-4 border rounded-lg p-4">
      <div className="space-y-2">
        <FormLabel>Schedule Frequency</FormLabel>
        <div className="flex flex-col sm:flex-row gap-2">
          <Select
            value={frequency}
            onValueChange={(val: ScheduleFrequency) => {
              setFrequency(val);
              if (val === "weekdays") {
                const weekdayValues = ["1", "2", "3", "4", "5"]; // Mon-Fri
                setSelectedDays(weekdayValues);
                updateCron(
                  val,
                  hours,
                  minutes,
                  dayOfWeek,
                  dayOfMonth,
                  weekdayValues,
                );
              } else if (val === "custom-weekly") {
                const defaultCustomDays = ["1", "3", "5"]; // Mon, Wed, Fri
                setSelectedDays(defaultCustomDays);
                updateCron(
                  val,
                  hours,
                  minutes,
                  dayOfWeek,
                  dayOfMonth,
                  defaultCustomDays,
                );
              } else {
                updateCron(
                  val,
                  hours,
                  minutes,
                  dayOfWeek,
                  dayOfMonth,
                  selectedDays,
                );
              }
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select frequency" />
            </SelectTrigger>
            <SelectContent>
              {process.env.NODE_ENV === "development" && (
                <SelectItem value="5-minutely">
                  Every 5 minutes (Dev-only)
                </SelectItem>
              )}
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="weekdays">Weekdays only</SelectItem>
              <SelectItem value="custom-weekly">Custom Weekly</SelectItem>
            </SelectContent>
          </Select>
          {frequency !== "5-minutely" && !showMultipleHoursInput && (
            <Combobox
              items={HOURS}
              value={`${hours[0]}:${minutes}`}
              setValue={(val) => {
                if (val) {
                  const parts = val.split(":");
                  const h = parts[0];
                  const m = parts[1];
                  if (h && m) {
                    const newHours = [h];
                    setHours(newHours);
                    setMinutes(m);
                    setHoursInputValue(newHours.join(", "));
                    updateCron(
                      frequency,
                      newHours,
                      m,
                      dayOfWeek,
                      dayOfMonth,
                      selectedDays,
                    );
                  }
                }
              }}
              placeholder="Select time"
              searchPlaceholder="Search time..."
              emptyText="No time found"
              disabled={false}
              className="max-w-[150px]"
              contentsClassName="w-[150px]"
            />
          )}
          {frequency !== "5-minutely" && showMultipleHoursInput && (
            <Combobox
              items={MINUTES}
              value={minutes}
              setValue={(val) => {
                if (val) {
                  setMinutes(val);
                  updateCron(
                    frequency,
                    hours,
                    val,
                    dayOfWeek,
                    dayOfMonth,
                    selectedDays,
                  );
                }
              }}
              placeholder="Select minutes"
              searchPlaceholder="Search minutes..."
              emptyText="No minutes found"
              disableSearch={true}
              disabled={false}
              className="max-w-[150px]"
              contentsClassName="w-[150px]"
            />
          )}
          <TimezoneSelector
            value={value.timezone}
            onChange={(timezone) => onChange({ ...value, timezone })}
          />
        </div>
      </div>
      {frequency !== "5-minutely" && (
        <div className="space-y-2">
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="multiple-hours"
              checked={showMultipleHoursInput}
              disabled={false}
              onChange={(e) => {
                const checked = e.target.checked;
                setShowMultipleHoursInput(checked);
                if (!checked) {
                  // Keep only the first hour
                  const firstHour = hours[0] ?? "9";
                  const newHours = [firstHour];
                  setHours(newHours);
                  updateCron(
                    frequency,
                    newHours,
                    minutes,
                    dayOfWeek,
                    dayOfMonth,
                    selectedDays,
                  );
                } else {
                  // Already has the current hour in state, just update cron
                  updateCron(
                    frequency,
                    hours,
                    minutes,
                    dayOfWeek,
                    dayOfMonth,
                    selectedDays,
                  );
                }
              }}
              className="h-4 w-4 rounded border-gray-300"
            />
            <label
              htmlFor="multiple-hours"
              className="text-sm flex items-center gap-2 cursor-pointer"
            >
              <span>Multiple times per day</span>
            </label>
          </div>
          {showMultipleHoursInput && (
            <div className="space-y-2 pl-6">
              <Input
                type="text"
                value={hoursInputValue}
                onChange={(e) => {
                  const val = e.target.value;
                  setHoursInputValue(val);

                  // Clear previous errors
                  setHoursInputError(null);

                  // If empty, clear everything
                  if (!val.trim()) {
                    setHoursInputError("At least one hour is required");
                    return;
                  }

                  // Parse comma-separated hours
                  const rawHours = val
                    .split(",")
                    .map((h) => h.trim())
                    .filter(Boolean);

                  // Check for too many hours
                  if (rawHours.length > MAX_HOURS_SCHEDULE_AUTOMATIONS) {
                    setHoursInputError(
                      `Maximum ${MAX_HOURS_SCHEDULE_AUTOMATIONS} hours allowed`,
                    );
                    return;
                  }

                  // Validate each hour
                  const invalidHours: string[] = [];
                  const validHours: string[] = [];

                  for (const h of rawHours) {
                    const hourNum = parseInt(h);
                    if (isNaN(hourNum) || hourNum < 0 || hourNum > 23) {
                      invalidHours.push(h);
                    } else {
                      validHours.push(String(hourNum));
                    }
                  }

                  if (invalidHours.length > 0) {
                    setHoursInputError(
                      `Invalid hour(s): ${invalidHours.join(", ")}. Hours must be between 0 and 23.`,
                    );
                    return;
                  }

                  if (validHours.length === 0) {
                    setHoursInputError("At least one valid hour is required");
                    return;
                  }

                  // Check for duplicates
                  const uniqueHours = [...new Set(validHours)];
                  if (uniqueHours.length !== validHours.length) {
                    setHoursInputError("Duplicate hours are not allowed");
                    return;
                  }

                  setHours(validHours);
                  updateCron(
                    frequency,
                    validHours,
                    minutes,
                    dayOfWeek,
                    dayOfMonth,
                    selectedDays,
                  );
                }}
                placeholder="e.g. 9, 12, 15, 18"
                className="font-mono"
              />
              {hoursInputError ? (
                <div className="text-xs text-destructive">
                  {hoursInputError}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Enter up to {MAX_HOURS_SCHEDULE_AUTOMATIONS} hours (0-23)
                  separated by commas
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {frequency === "weekly" && (
        <div className="space-y-2">
          <FormLabel>Select Day</FormLabel>
          <div className="flex gap-1">
            {DAYS_OF_WEEK.map((day) => (
              <button
                key={day.value}
                type="button"
                onClick={() => {
                  setDayOfWeek(day.value);
                  updateCron(
                    frequency,
                    hours,
                    minutes,
                    day.value,
                    dayOfMonth,
                    selectedDays,
                  );
                }}
                className={cn(
                  "h-10 w-10 rounded-full text-sm font-medium transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                  dayOfWeek === day.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground",
                )}
              >
                {day.short.charAt(0)}
              </button>
            ))}
          </div>
        </div>
      )}

      {frequency === "monthly" && (
        <div className="space-y-2">
          <FormLabel>Day of Month</FormLabel>
          <Input
            type="number"
            min="1"
            max="31"
            value={dayOfMonth}
            onChange={(e) => {
              const val = e.target.value;
              setDayOfMonth(val);
              updateCron(
                frequency,
                hours,
                minutes,
                dayOfWeek,
                val,
                selectedDays,
              );
            }}
            placeholder="Enter day (1-31)"
            className="w-[100px]"
          />
        </div>
      )}

      {(frequency === "custom-weekly" || frequency === "weekdays") && (
        <div className="space-y-2">
          <FormLabel>Select Days</FormLabel>
          <div className="flex gap-1">
            {DAYS_OF_WEEK.map((day) => (
              <button
                key={day.value}
                type="button"
                onClick={() => {
                  const newDays = selectedDays.includes(day.value)
                    ? selectedDays.filter((d) => d !== day.value)
                    : [...selectedDays, day.value];
                  setSelectedDays(newDays);
                  // If we're in weekdays mode and the selection no longer matches Mon-Fri, switch to custom
                  if (frequency === "weekdays") {
                    setFrequency("custom-weekly");
                    updateCron(
                      "custom-weekly",
                      hours,
                      minutes,
                      dayOfWeek,
                      dayOfMonth,
                      newDays,
                    );
                  } else {
                    updateCron(
                      frequency,
                      hours,
                      minutes,
                      dayOfWeek,
                      dayOfMonth,
                      newDays,
                    );
                  }
                }}
                className={cn(
                  "h-10 w-10 rounded-full text-sm font-medium transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
                  selectedDays.includes(day.value)
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground",
                )}
              >
                {day.short.charAt(0)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-sm text-muted-foreground">
          <span className="font-medium">Schedule: </span>
          {getCronDescription(value.cron)}
        </div>
        {isValid ? (
          (() => {
            const nextRun = getNextRunTime({
              cron: value.cron,
              timezone: value.timezone,
              options: { accessTier: tier },
            });
            return nextRun ? (
              <div className="text-sm text-muted-foreground">
                <span className="font-medium">Next run: </span>
                {nextRun.toLocaleString(undefined, {
                  timeZone: value.timezone,
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </div>
            ) : null;
          })()
        ) : error === "unsupported-pattern" ? (
          <div className="text-sm text-destructive">
            This schedule is not supported.
          </div>
        ) : error === "invalid-syntax" ? (
          <div className="text-sm text-destructive">
            Invalid schedule. Please check your schedule configuration.
          </div>
        ) : error === "pro-only" ? (
          <div className="text-sm text-destructive">
            This schedule requires a higher automation access level.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TimezoneSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <ResponsiveCombobox
      items={Intl.supportedValuesOf("timeZone").map((tz) => ({
        value: tz,
        label: tz,
      }))}
      value={value}
      setValue={(value) => {
        onChange(value || Intl.DateTimeFormat().resolvedOptions().timeZone);
      }}
      disabled={false}
      placeholder="Select timezone"
      searchPlaceholder="Search timezones..."
      emptyText="No timezone found"
    />
  );
}

const DAYS_OF_WEEK = [
  { value: "1", label: "Monday", short: "Mon" },
  { value: "2", label: "Tuesday", short: "Tue" },
  { value: "3", label: "Wednesday", short: "Wed" },
  { value: "4", label: "Thursday", short: "Thu" },
  { value: "5", label: "Friday", short: "Fri" },
  { value: "6", label: "Saturday", short: "Sat" },
  { value: "0", label: "Sunday", short: "Sun" },
];

const HOURS = Array.from({ length: 48 }, (_, i) => {
  const hour = Math.floor(i / 2);
  const minute = i % 2 === 0 ? "00" : "30";
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const period = hour < 12 ? "AM" : "PM";

  return {
    value: `${hour}:${minute}`,
    label: `${displayHour}:${minute} ${period}`,
  };
});

const MINUTES = [
  { value: "00", label: "XX:00" },
  { value: "30", label: "XX:30" },
];
